// FAKE ERP (development tool): its own tiny data store, completely separate from the WMS database.
// A JSON file (tools/fake-erp/data/erp.json, git-ignored) or, for tests, memory only.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Product {
  sku: string;
  name: string;
  description: string;
  barcodes: string[];
}
export interface OrderLine {
  sku: string;
  quantity: number;
}
export interface Order {
  id: string; // ERP order number; also the external id sent to the WMS
  status: "OPEN" | "CANCELLED";
  note: string;
  lines: OrderLine[];
  createdAt: string;
}
export type MessageType = "product.upsert" | "order.create" | "order.cancel";
export interface SendAttempt {
  at: string;
  httpStatus: number | null;
  error: string | null;
  body: string;
  durationMs: number;
}
/** A webhook the ERP wants to send to the WMS. `occurredAt` is fixed at creation so a re-send is byte-identical (the WMS then answers "duplicate"). */
export interface Message {
  id: string; // the event id
  type: MessageType;
  occurredAt: string;
  data: Record<string, unknown>;
  status: "PENDING" | "SENT" | "FAILED";
  createdAt: string;
  attempts: SendAttempt[];
}
export interface InboxEvent {
  id: string;
  type: string;
  deliveryId: string;
  attempt: string;
  receivedAt: string;
  verification: string;
  respondedWith: number;
  mode: string;
  duplicate: boolean;
  payload: unknown; // already redacted
}
export type ResponseMode = "200" | "400" | "429" | "500" | "delay";
export interface Settings {
  wmsBaseUrl: string;
  publicId: string;
  /** Secret the ERP uses to SIGN what it sends to the WMS (= the WMS integration's "inbound signing secret"). */
  inboundSecret: string;
  /** Secret the ERP uses to VERIFY what the WMS sends (= the WMS integration's "outbound signing secret"). */
  outboundSecret: string;
  responseMode: ResponseMode;
  delayMs: number;
  retryAfterSeconds: number;
}
export interface State {
  products: Product[];
  orders: Order[];
  messages: Message[];
  inbox: InboxEvent[];
  settings: Partial<Settings>;
}

const now = () => new Date().toISOString();

/** Deterministic demo data. Event ids are random, everything else is fixed. */
export function seedState(settings: Partial<Settings> = {}): State {
  const products: Product[] = [
    { sku: "DEMO-001", name: "Blue Widget", description: "Fake ERP demo product", barcodes: ["5000000000011"] },
    { sku: "DEMO-002", name: "Red Widget", description: "Fake ERP demo product", barcodes: ["5000000000028"] },
    { sku: "DEMO-003", name: "Green Widget", description: "Fake ERP demo product", barcodes: ["5000000000035"] },
  ];
  const orders: Order[] = [
    { id: "ERP-ORDER-001", status: "OPEN", note: "Demo order 1", lines: [{ sku: "DEMO-001", quantity: 5 }, { sku: "DEMO-002", quantity: 2 }], createdAt: now() },
    { id: "ERP-ORDER-002", status: "OPEN", note: "Demo order 2", lines: [{ sku: "DEMO-003", quantity: 10 }], createdAt: now() },
  ];
  const messages = [...products.map(productMessage), ...orders.map(orderCreateMessage)];
  return { products, orders, messages, inbox: [], settings };
}

const base = (type: MessageType, data: Record<string, unknown>): Message => ({ id: randomUUID(), type, occurredAt: now(), data, status: "PENDING", createdAt: now(), attempts: [] });

export const externalProductId = (sku: string) => `erp-prod-${sku}`;
export const productMessage = (p: Product): Message =>
  base("product.upsert", { externalId: externalProductId(p.sku), sku: p.sku, name: p.name, description: p.description, barcodes: p.barcodes });
export const orderCreateMessage = (o: Order): Message =>
  base("order.create", {
    externalId: o.id,
    orderNumber: o.id,
    note: o.note,
    ready: true,
    lines: o.lines.map((l) => ({ externalProductId: externalProductId(l.sku), sku: l.sku, quantity: l.quantity })),
  });
export const orderCancelMessage = (o: Order): Message => base("order.cancel", { externalId: o.id });

/** Load/save the state. `file = null` keeps everything in memory (tests). */
export class Store {
  state: State;
  constructor(private readonly file: string | null) {
    this.state = (file && this.read(file)) || seedState();
  }

  private read(file: string): State | null {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as State;
    } catch {
      return null;
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /** Reset the demo data (products, orders, queued messages, received events). Connection settings are kept. */
  reset() {
    this.state = seedState(this.state.settings);
    this.save();
  }
}
