import { useKindeAuth } from "@kinde-oss/kinde-auth-react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { Component, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const refusal = (error: unknown) => (error instanceof ConvexError ? (error.data as { code: string; message: string }) : { code: "ERROR", message: String(error) });

export function App() {
  const { login, register } = useKindeAuth();
  return (
    <main>
      <header>
        <h1>Projects</h1>
        <p className="lede">Each Kinde organization sees only its own projects. The tenant comes from the access token's org_code, checked in every Convex function by kinde-tenant-guard.</p>
      </header>
      <AuthLoading>
        <p className="muted">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <div className="row">
          <button onClick={() => login()}>Sign in</button>
          <button className="secondary" onClick={() => register()}>Sign up</button>
        </div>
      </Unauthenticated>
      <Authenticated>
        <Workspace />
      </Authenticated>
    </main>
  );
}

function Workspace() {
  const ensure = useMutation(api.tenants.ensure);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void ensure().finally(() => setReady(true));
  }, [ensure]);
  return (
    <>
      <Account />
      {ready ? (
        <ShowRefusal>
          <ProjectList />
        </ShowRefusal>
      ) : (
        <p className="muted">Opening your organization…</p>
      )}
      <TokenPanel />
    </>
  );
}

function Account() {
  const { user, logout, login, getUserOrganizations, getCurrentOrganization } = useKindeAuth();
  const [orgs, setOrgs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    void getUserOrganizations().then((codes) => setOrgs(codes ?? []));
    void getCurrentOrganization().then((code) => setActive(code ?? null));
  }, [getUserOrganizations, getCurrentOrganization]);
  return (
    <section className="account">
      <span>{user?.email}</span>
      <label>
        Organization
        {/* login() with orgCode, not switchOrg(): switchOrg() leaves out the API audience, so Convex would reject the new token. */}
        <select value={active ?? ""} onChange={(e) => void login({ orgCode: e.target.value })}>
          {!active && <option value="">None</option>}
          {orgs.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>
      <button className="secondary" onClick={() => void logout()}>
        Sign out
      </button>
    </section>
  );
}

function ProjectList() {
  const create = useMutation(api.projects.create);
  const remove = useMutation(api.projects.remove);
  const [name, setName] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const projects = useQuery(api.projects.list);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(refusal(e));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await create({ name });
      setName("");
    });
  };

  const shown = error;
  return (
    <section>
      <form onSubmit={submit} className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" aria-label="New project name" />
        <button type="submit">Add</button>
      </form>
      {shown && (
        <p className="refusal" role="alert">
          <code>{shown.code}</code> {shown.message}
        </p>
      )}
      {projects === undefined && <p className="muted">Loading projects…</p>}
      {projects?.length === 0 && <p className="muted">No projects in this organization yet.</p>}
      <ul>
        {projects?.map((p) => (
          <li key={p._id}>
            <span>{p.name}</span>
            <button className="secondary" onClick={() => void run(() => remove({ id: p._id as Id<"projects"> }))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TokenPanel() {
  const seen = useQuery(api.tenants.whoami);
  if (!seen) return null;
  return (
    <details>
      <summary>What Convex received from Kinde</summary>
      <pre>{JSON.stringify(seen, null, 2)}</pre>
    </details>
  );
}

// A query that the guard refuses throws during render, so the refusal is shown here.
class ShowRefusal extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    const { code, message } = refusal(this.state.error);
    return (
      <p className="refusal" role="alert">
        <code>{code}</code> {message}
      </p>
    );
  }
}
