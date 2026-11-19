import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";
import type { GenericId } from "convex/values";
import { tenants } from "./guard.js";

type Id = GenericId<"projects">;
let saved: any = null;

export const listProjects = query({
  args: {},
  handler: (ctx) => tenants.withTenant(ctx, async (t) => (await t.db.query("projects").collect()).map((p: any) => p.slug)),
});

export const orderedProjects = query({
  args: {},
  handler: (ctx) => tenants.withTenant(ctx, async (t) => (await t.db.query("projects").order("desc").take(10)).map((p: any) => p.slug)),
});

export const projectBySlug = query({
  args: { slug: v.string() },
  handler: (ctx, { slug }) => tenants.withTenant(ctx, async (t) => (await t.db.query("projects").withIndex("by_tenant_slug", (q: any) => q.eq("slug", slug)).unique())?.name ?? null),
});

export const unscopedIndex = query({
  args: { slug: v.string() },
  handler: (ctx, { slug }) => tenants.withTenant(ctx, async (t) => t.db.query("projects").withIndex("by_slug" as any, (q: any) => q.eq("slug", slug)).collect()),
});

export const search = query({
  args: { text: v.string() },
  handler: (ctx, { text }) => tenants.withTenant(ctx, async (t) => (await t.db.query("projects").withSearchIndex("search_name", (q: any) => q.search("name", text)).collect()).map((p: any) => p.slug)),
});

export const unscopedSearch = query({
  args: { text: v.string() },
  handler: (ctx, { text }) => tenants.withTenant(ctx, async (t) => t.db.query("projects").withSearchIndex("search_name_unscoped" as any, (q: any) => q.search("name", text)).collect()),
});

export const getProject = query({
  args: { id: v.string(), withTable: v.boolean() },
  handler: (ctx, { id, withTable }) =>
    tenants.withTenant(ctx, async (t) => {
      const doc = withTable ? await t.db.get("projects", id as Id) : await t.db.get(id as Id);
      return doc?.slug ?? null;
    }),
});

export const readPlans = query({
  args: {},
  handler: (ctx) => tenants.withTenant(ctx, async (t) => (await t.db.query("plans").collect()).map((p: any) => p.name)),
});

export const readUnregistered = query({
  args: {},
  handler: (ctx) => tenants.withTenant(ctx, async (t) => t.db.query("auditLog").collect()),
});

export const queryHasNoWriter = query({
  args: {},
  handler: (ctx) => tenants.withTenant(ctx, async (t) => typeof (t.db as any).insert),
});

export const createProject = mutation({
  args: { name: v.string(), slug: v.string(), tenantId: v.optional(v.string()) },
  handler: (ctx, args) =>
    tenants.withTenant(ctx, async (t) => {
      const id = await t.db.insert("projects", args);
      return (await ctx.db.get(id))!.tenantId;
    }),
});

export const renameProject = mutation({
  args: { id: v.string(), name: v.string(), withTable: v.boolean() },
  handler: (ctx, { id, name, withTable }) =>
    tenants.withTenant(ctx, async (t) => (withTable ? t.db.patch("projects", id as Id, { name }) : t.db.patch(id as Id, { name }))),
});

export const moveProject = mutation({
  args: { id: v.string(), tenantId: v.string() },
  handler: (ctx, { id, tenantId }) => tenants.withTenant(ctx, async (t) => t.db.patch(id as Id, { tenantId })),
});

export const replaceProject = mutation({
  args: { id: v.string(), name: v.string(), slug: v.string() },
  handler: (ctx, { id, name, slug }) =>
    tenants.withTenant(ctx, async (t) => {
      await t.db.replace(id as Id, { name, slug });
      return (await ctx.db.get(id as Id))!.tenantId;
    }),
});

export const deleteProject = mutation({
  args: { id: v.string() },
  handler: (ctx, { id }) => tenants.withTenant(ctx, async (t) => t.db.delete(id as Id)),
});

export const tableApi = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) =>
    tenants.withTenant(ctx, async (t) => {
      const projects = (t.db as any).table("projects");
      const id = await projects.insert({ name, slug: name });
      return { tenantId: (await projects.get(id)).tenantId, count: (await projects.query().collect()).length };
    }),
});

export const writePlan = mutation({
  args: {},
  handler: (ctx) => tenants.withTenant(ctx, async (t) => (t.db as any).insert("plans", { name: "free" })),
});

export const deleteInvoice = mutation({
  args: { id: v.string() },
  handler: (ctx, { id }) => tenants.withTenant(ctx, async (t) => t.db.delete(id as GenericId<"invoices">)),
});

export const saveDatabase = mutation({
  args: {},
  handler: (ctx) =>
    tenants.withTenant(ctx, async (t) => {
      saved = t.db;
      return null;
    }),
});

export const useSavedDatabase = mutation({
  args: {},
  handler: async () => saved.query("projects").collect(),
});

export const nightlyCount = query({
  args: { tenantId: v.optional(v.string()) },
  handler: (ctx, { tenantId }) => tenants.withSystem(ctx, { reason: "nightly report", tenantId }, async (s) => (await s.db.query("projects").collect()).length),
});

export const isoCreate = mutation({
  args: { slug: v.string() },
  handler: (ctx, { slug }) =>
    tenants.withTenant(ctx, async (t) => {
      const id = await t.db.insert("projects", { name: "Isolation", slug });
      return t.db.get(id);
    }),
});

export const isoList = query({ args: {}, handler: (ctx) => tenants.withTenant(ctx, (t) => t.db.query("projects").collect()) });

export const isoGet = query({ args: { id: v.string() }, handler: (ctx, { id }) => tenants.withTenant(ctx, (t) => t.db.get(id as Id)) });

export const isoUpdate = mutation({ args: { id: v.string() }, handler: (ctx, { id }) => tenants.withTenant(ctx, (t) => t.db.patch(id as Id, { name: "changed" })) });

export const isoRemove = mutation({ args: { id: v.string() }, handler: (ctx, { id }) => tenants.withTenant(ctx, (t) => t.db.delete(id as Id)) });
