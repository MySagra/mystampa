import Jimp from 'jimp';

export interface ImageOptions {
    paperWidth?: number;       // default 384
    exactWidth?: number;       // resize image to exact width
    exactHeight?: number;      // resize image to exact height
    inlineText?: string;       // text to append on the right side of the image
}

/**
 * Converts an image file to an ESC/POS raster image Buffer.
 * Supports resizing and dithering/thresholding to black and white.
 * Max width is typically 384 (58mm) or 576 (80mm).
 * Returns an empty buffer if the file cannot be loaded.
 */
export async function loadImageAsEscPos(
    filePath: string,
    options: ImageOptions = {}
): Promise<Buffer> {
    try {
        const img = await Jimp.read(filePath);

        // Automatically crop any solid transparent/white margins from the source image
        img.autocrop();

        // Resize image based on provided options
        if (options.exactWidth || options.exactHeight) {
            const w = options.exactWidth || Jimp.AUTO;
            const h = options.exactHeight || Jimp.AUTO;
            img.resize(w, h);
        }

        let itemWidth = img.bitmap.width;
        let itemHeight = img.bitmap.height;

        let textImage: any = null;
        let textWidth = 0;

        // If inlineText is provided, load font and measure
        if (options.inlineText) {
            const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK); // Font più grande (era 16)
            textWidth = Jimp.measureText(font, options.inlineText);
            const textHeight = Jimp.measureTextHeight(font, options.inlineText, 1000);

            textImage = new Jimp(textWidth, Math.max(itemHeight, textHeight), 0xffffffff);
            textImage.print(font, 0, Math.floor(Math.max(0, (itemHeight - textHeight) / 2)), options.inlineText);

            itemWidth += textWidth + 10; // 10px spacing
            itemHeight = Math.max(itemHeight, textImage.bitmap.height);
        }

        const paperWidth = options.paperWidth || 384;
        const widthBytes = Math.ceil(paperWidth / 8);
        const paddedWidth = widthBytes * 8; // e.g. 384

        // Create a new white canvas of the full paper width
        const canvas = new Jimp(paddedWidth, itemHeight, 0xffffffff);

        // Center the content on the canvas
        const startX = Math.floor((paddedWidth - itemWidth) / 2);

        // Paste logo
        canvas.composite(img, startX, Math.floor((itemHeight - img.bitmap.height) / 2));

        // Paste text if any
        if (textImage) {
            canvas.composite(textImage, startX + img.bitmap.width + 10, 0);
        }

        // Convert to black and white (thresholding)
        canvas.greyscale().contrast(1).posterize(2);

        const xL = widthBytes % 256;
        const xH = Math.floor(widthBytes / 256);
        const yL = itemHeight % 256;
        const yH = Math.floor(itemHeight / 256);

        // ESC/POS command for GS v 0 (raster print)
        // 1D 76 30 00 xL xH yL yH
        const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
        const data = Buffer.alloc(widthBytes * itemHeight);

        for (let y = 0; y < itemHeight; y++) {
            for (let x = 0; x < paddedWidth; x++) {
                const color = canvas.getPixelColor(x, y);
                // RGBA -> extract RGB. In grayscale, R=G=B.
                const r = Jimp.intToRGBA(color).r;
                const alpha = Jimp.intToRGBA(color).a;

                // Pixel is black if it's not transparent AND it's dark
                let isBlack = 0;
                if (alpha > 128 && r < 128) {
                    isBlack = 1;
                }

                if (isBlack) {
                    const byteIndex = y * widthBytes + Math.floor(x / 8);
                    const bitIndex = 7 - (x % 8);
                    data[byteIndex] |= (1 << bitIndex);
                }
            }
        }

        // Return header + data
        return Buffer.concat([header, data]);
    } catch (err) {
        console.error(`[ImageToEscPos] Failed to process image ${filePath}:`, err);
        return Buffer.alloc(0);
    }
}
