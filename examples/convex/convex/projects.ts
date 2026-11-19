import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { asClientError, tenants } from "./tenant";

export const list = query({
  args: {},
  handler: (ctx) =>
    asClientError(() => tenants.withTenant(ctx, (t) => t.db.query("projects").order("desc").collect())),
});

export const create = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) =>
    asClientError(() =>
      tenants.withTenant(ctx, (t) => t.db.insert("projects", { name: name.trim().slice(0, 80) || "Untitled", createdBy: t.context.principal.userId })),
    ),
});

export const remove = mutation({
  args: { id: v.id("projects") },
  handler: (ctx, { id }) => asClientError(() => tenants.withTenant(ctx, (t) => t.db.delete(id))),
});
