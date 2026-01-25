/**
 * Domain models used by the mystampa service.
 *
 * These classes mirror the structure of the JSON objects returned by the
 * external API. They also provide convenient constructors for creating
 * instances from plain objects.
 */

/**
 * Class representing a category record in the database.
 *
 * The `categories` table contains information about menu
 * categories that group foods (e.g. “Pizza”, “Drinks”). Each
 * category has its own printer for kitchen orders so that
 * entire categories can be routed to a specific station. The
 * `position` field controls ordering of categories in the UI and
 * the optional `image` can be used to display an icon. The
 * optional `printerId` references the printer associated with
 * this category.
 */
export class Category {
  constructor(
    public id: string,
    public name: string,
    public available: boolean = true,
    public position: number = 0,
    public image: string | null = null,
    public printerId: string | null = null
  ) {}

  /**
   * Create a Category instance from a plain object (API response or
   * database row). Any missing properties are given sensible
   * defaults. Leading/trailing whitespace is trimmed.
   */
  static fromJson(data: any): Category {
    return new Category(
      String(data.id),
      String(data.name),
      data.available !== undefined ? Boolean(data.available) : true,
      data.position !== undefined ? Number(data.position) : 0,
      data.image ?? null,
      data.printerId ?? null
    );
  }
}

/**
 * Alias for a category entity. Some parts of the code refer to
 * `CategoryEntity` to emphasise that this class maps directly to
 * the `categories` table. It simply extends {@link Category} so
 * all behaviour is inherited.
 */
export class CategoryEntity extends Category {}

export class Printer {
  constructor(
    public id: string,
    public name: string,
    public ip: string,
    public port: number,
    public description: string | null = null,
    public status: string = 'UNKNOWN'
  ) {}

  /**
   * Create a Printer instance from a plain object. The port property
   * returned by the API may be a string (e.g. "9.100" in locale with dots)
   * so we attempt to parse it as a number.
   */
  static fromJson(data: any): Printer {
    // Normalize and trim values to remove unexpected whitespace and locale formatting.
    const name: string = data.name ? String(data.name).trim() : '';
    const ip: string = data.ip ? String(data.ip).trim() : '';
    // Port may be a string with dots (e.g. "9.100") or whitespace, remove dots and trim.
    let portValue: number;
    if (typeof data.port === 'string') {
      const cleaned = data.port.toString().trim().replace(/\./g, '');
      portValue = parseInt(cleaned, 10);
    } else {
      portValue = data.port;
    }
    return new Printer(
      data.id,
      name,
      ip,
      portValue,
      data.description ?? null,
      data.status ?? 'UNKNOWN'
    );
  }
}

/**
 * Alias class representing a printer record in the database.
 *
 * This class exists to clearly separate the concept of an API
 * printer from any other conceptual printers that might be
 * defined elsewhere in the application. It inherits from the
 * {@link Printer} class so all parsing logic and properties are
 * identical.
 */
export class PrinterEntity extends Printer {}

export class Food {
  constructor(
    public id: string,
    public name: string,
    public description: string | null = null,
    public price: string
  ) {}
}

export class OrderItem {
  constructor(
    public id: string,
    public quantity: number,
    public notes: string | null = null,
    public food: Food
  ) {}
}

export class CategorizedItems {
  constructor(
    public category: { id: string | number; name: string },
    public items: OrderItem[]
  ) {}
}

export class PrintJob {
  constructor(
    public id: string,
    public orderId: number | null = null,
    public ticketNumber: number | null = null,
    public paymentMethod: string | null = null,
    public surcharge: number | null = null,
    public discount: number | null = null,
    public subtotal: number | null = null,
    public total: number | null = null,
    public displayCode: string | null = null,
    public table: string | null = null,
    public customer: string | null = null,
    public confirmedAt: string | null = null,
    public categorizedItems: CategorizedItems[]
  ) {}
}

/**
 * Types and interfaces for the updated `mycassa` service.
 *
 * The IncomingOrder type matches the structure of the JSON payload
 * received by the `/print` endpoint. It reflects the order and
 * associated items before they are grouped by category or printer.
 */

// Accept either a string or numeric identifier. Some APIs may return
// numbers for identifiers while others use strings.
export type IdLike = string | number;

/**
 * Structure of each entry in the incoming orderItems array. Each
 * order item references a food by its `foodId`, includes the
 * quantity ordered and optional notes (e.g. modifications).
 */
export interface OrderItemIn {
  id: string;
  quantity: number;
  foodId: string;
  notes: string | null;
  /**
   * Optional surcharge applied to this specific item. This value
   * represents an additional price (e.g. supplement) and should be
   * added to the base price of the food when calculating totals.
   */
  surcharge?: number | string | null;
  /**
   * Optional order identifier associated with the item. When present,
   * it links the item back to its parent order.
   */
  orderId?: IdLike;
}

/**
 * Top level structure for incoming orders. This interface captures
 * common metadata such as table number, customer name and timestamps
 * alongside an array of orderItems. It also includes optional
 * monetary fields that may be provided by the API.
 */
export interface IncomingOrder {
  id: IdLike;
  displayCode?: string | null;
  table?: string | null;
  customer?: string | null;
  createdAt?: string | null;
  confirmedAt?: string | null;
  ticketNumber?: number | null;
  status?: string | null;
  paymentMethod?: string | null;

  subTotal?: string | number | null;
  discount?: string | number | null;
  surcharge?: string | number | null;
  total?: string | number | null;

  cashRegisterId?: IdLike | null;

  /**
   * Identifier of the user who created the order. This property may
   * be omitted when the API does not provide it.
   */
  userId?: string | null;

  orderItems: OrderItemIn[];
}

/**
 * API response when fetching a single food by ID via
 * GET /v1/foods/{id}. The food may include additional optional
 * properties such as categoryId or printerId that are useful for
 * routing the item to a specific kitchen printer.
 */
export interface FoodFromApi {
  id: string;
  name: string;
  description?: string | null;
  price: number | string;
  printerId?: string | null;
  categoryId?: string | null;
  available?: boolean;
}

/**
 * API response when fetching a cash register by ID with printer
 * details included via `include=printer`. The printer details may
 * appear either as a separate `printerId` or nested inside the
 * `printer` object.
 */
export interface CashRegisterFromApi {
  id: IdLike;
  defaultPrinterId?: string | null;
  defaultPrinter?: {
    id: string;
    ip?: string | null;
    port?: number | string | null;
    name?: string | null;
  } | null;
}

/**
 * Class representing a food record in the database. It mirrors the
 * columns of the `foods` table: id, name, description, price,
 * availability status, associated category and optional printer.
 */
export class FoodEntity {
  constructor(
    public id: string,
    public name: string,
    public description: string | null,
    public price: number | string,
    public available: boolean,
    public categoryId: string | null,
    public printerId: string | null
  ) {}

  /**
   * Create a FoodEntity from a plain API response or database row.
   */
  static fromJson(data: any): FoodEntity {
    return new FoodEntity(
      data.id,
      data.name,
      data.description ?? null,
      data.price,
      Boolean(data.available),
      data.categoryId ?? null,
      data.printerId ?? null
    );
  }
}

/**
 * Class representing a cash register record in the database. It mirrors
 * the columns of the `cash_registers` table: id, name, enabled and
 * default printer reference. In addition to the primary fields it
 * optionally includes the current printer object when the API
 * populates it via `include=printer`.
 */
export class CashRegister {
  constructor(
    public id: IdLike,
    public name: string,
    public enabled: boolean,
    public defaultPrinterId: string | null = null,
    public printer?: Printer | null
  ) {}

  /**
   * Create a CashRegister from a plain API response or database row.
   */
  static fromJson(data: any): CashRegister {
    const printerObj = data.printer ? Printer.fromJson(data.printer) : null;
    return new CashRegister(
      data.id,
      data.name,
      Boolean(data.enabled),
      data.defaultPrinterId ?? data.printerId ?? null,
      printerObj
    );
  }
}

/**
 * Alias for a cash register entity. This type exists so that
 * consumers can explicitly refer to database records rather
 * than API representations. It inherits from {@link CashRegister}
 * so all behaviour and parsing logic are shared.
 */
export class CashRegisterEntity extends CashRegister {}