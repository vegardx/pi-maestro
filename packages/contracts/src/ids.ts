// Branded identifier types. Purely compile-time (zero runtime): the brand is
// erased on emit, so these are just `string` at runtime but distinct to the
// type checker. The owning module (run store, plan store) mints them.

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, "RunId">;
export type DeliverableId = Brand<string, "DeliverableId">;
export type WorkItemId = Brand<string, "WorkItemId">;
export type PlanId = Brand<string, "PlanId">;
export type SessionId = Brand<string, "SessionId">;
