import { relations } from "drizzle-orm";
import { integer, pgTable, serial, text, unique } from "drizzle-orm/pg-core";
import { tenantIdColumn } from "../src/drizzle.js";

// A global table: shared by all tenants, mapping Kinde organizations to internal tenant IDs.
export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  kindeOrgCode: text("kinde_org_code").notNull().unique(),
  name: text("name").notNull(),
});

export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    tenantId: tenantIdColumn(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
  },
  (t) => [unique("projects_slug").on(t.slug)],
);

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  tenantId: tenantIdColumn(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  amount: integer("amount").notNull(),
});

export const projectRelations = relations(projects, ({ many }) => ({ invoices: many(invoices) }));
export const invoiceRelations = relations(invoices, ({ one }) => ({ project: one(projects, { fields: [invoices.projectId], references: [projects.id] }) }));

export const schema = { tenants, projects, invoices, projectRelations, invoiceRelations };

export const CREATE_TABLES = `
DROP TABLE IF EXISTS invoices, projects, tenants, notes CASCADE;
CREATE TABLE tenants (id text PRIMARY KEY, kinde_org_code text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE projects (id serial PRIMARY KEY, tenant_id text NOT NULL, slug text NOT NULL CONSTRAINT projects_slug UNIQUE, name text NOT NULL);
CREATE TABLE invoices (id serial PRIMARY KEY, tenant_id text NOT NULL, project_id integer NOT NULL REFERENCES projects(id), amount integer NOT NULL);
CREATE TABLE notes (id serial PRIMARY KEY, tenant_id text NOT NULL, body text NOT NULL);
INSERT INTO tenants VALUES ('t_acme', 'org_acme', 'Acme'), ('t_globex', 'org_globex', 'Globex');
`;
