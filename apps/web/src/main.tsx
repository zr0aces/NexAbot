import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Routes, Route, Link } from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import {
  LayoutDashboard,
  Images,
  Layers,
  Users,
  Activity,
  Settings as Gear,
  CloudUpload,
  LogOut,
  Moon,
  Sun,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "../../../packages/ui/button";
import { api, query, labels, type Stats } from "./data";
import { Dashboard, Groups, Settings, Health } from "./workspace";
import { Library } from "./photos";
import "./style.css";

const navSections = [
  {
    title: "LIBRARY",
    items: [
      ["dashboard", "/", LayoutDashboard],
      ["gallery", "/gallery", Images],
      ["albums", "/albums", Layers],
    ] as const,
  },
  {
    title: "PIPELINE",
    items: [
      ["groups", "/groups", Users],
      ["jobs", "/jobs", CloudUpload],
      ["settings", "/settings", Gear],
      ["health", "/health", Activity],
    ] as const,
  },
];

const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

function Brand() {
  return (
    <div className="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <use href="/photo-peak.svg#mark" />
      </svg>
      NexAbot
    </div>
  );
}

function Login({ setup }: { setup: boolean }) {
  const { register, handleSubmit, formState } = useForm<{
    email: string;
    password: string;
    bootstrap: string;
  }>();
  const [error, set] = useState("");
  return (
    <main className="entry">
      <div className="entrySide">
        <Brand />
        <div>
          <small>PRIVATE PHOTO ARCHIVE</small>
          <h1>
            Your groups.
            <br />
            One contact sheet.
          </h1>
          <p>
            A private home for the photos your LINE groups send to Google
            Photos — staged safely, never silently dropped.
          </p>
        </div>
        <div className="contactMotif" aria-hidden="true">
          <div className="contactCell" />
          <div className="contactCell lit" />
          <div className="contactCell" />
          <div className="contactCell lit" />
          <div className="contactCell" />
          <div className="contactCell lit" />
        </div>
        <span className="mono">LINE → Staging → Google Photos</span>
      </div>
      <form
        onSubmit={handleSubmit(async (data) => {
          try {
            await api("/auth/" + (setup ? "setup" : "login"), "POST", data);
            await client.invalidateQueries();
          } catch (e) {
            set((e as Error).message);
          }
        })}
      >
        <small>OWNER ACCESS</small>
        <h2>{setup ? "Create your account" : "Welcome back"}</h2>
        {setup && (
          <p>Use the setup key from your deployment to claim this library.</p>
        )}
        <label>
          Email
          <input
            required
            autoComplete="username"
            type="email"
            {...register("email")}
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            minLength={setup ? 12 : 1}
            {...register("password")}
          />
          {setup && <small>Minimum 12 characters</small>}
        </label>
        {setup && (
          <label>
            Setup key
            <input type="password" required {...register("bootstrap")} />
          </label>
        )}
        <Button disabled={formState.isSubmitting}>
          {setup ? "Create owner account" : "Sign in"}{" "}
          <ArrowUpRight size={16} />
        </Button>
        <p role="alert">{error}</p>
      </form>
    </main>
  );
}

function App() {
  const [dark, theme] = useState(
    () => localStorage.getItem("gallery-theme") === "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("gallery-theme", dark ? "dark" : "light");
  }, [dark]);

  const auth = query<{ setup: boolean; authenticated: boolean }>(
      "/auth/status",
    ),
    qc = useQueryClient();
  const stats = useQueryClient().getQueryData<Stats>(["/dashboard/stats"]);

  if (auth.error)
    return (
      <main role="alert">
        Cannot reach the gallery. Check the API connection.
      </main>
    );
  if (!auth.data) return <main>Opening library…</main>;
  if (!auth.data.authenticated) return <Login setup={auth.data.setup} />;

  const signOut = async () => {
    await api("/auth/logout", "POST");
    qc.clear();
    location.assign("/");
  };
  const attentionCount = (stats?.failed ?? 0) + (stats?.pending ?? 0);

  return (
    <div className="shell">
      <aside>
        <div className="asideTop">
          <Brand />
          <div className="mobileActions">
            <Button
              variant="ghost"
              aria-label="Dark theme"
              aria-pressed={dark}
              onClick={() => theme(!dark)}
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </Button>
            <Button variant="ghost" aria-label="Sign out" onClick={signOut}>
              <LogOut size={16} />
            </Button>
          </div>
        </div>
        <nav aria-label="Primary">
          {navSections.map((sec) => (
            <div className="navGroup" key={sec.title}>
              <small>{sec.title}</small>
              {sec.items.map(([k, to, Icon]) => (
                <NavLink end key={k} to={to}>
                  <Icon size={17} />
                  <span>{labels[k]}</span>
                  {k === "jobs" && attentionCount > 0 && (
                    <span className="navBadge">{attentionCount}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="asideFooter">
          <Button variant="ghost" onClick={signOut}>
            <LogOut size={16} />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <span className="dot" />
          <span>Private workspace</span>
          {stats?.google && (
            <span
              className={
                "pill " + (stats.google === "CONNECTED" ? "ok" : "warn")
              }
            >
              Google {stats.google.toLowerCase()}
            </span>
          )}
          <span className="tz">Asia/Bangkok</span>
          <Button
            className="desktopOnly"
            variant="ghost"
            aria-label="Dark theme"
            aria-pressed={dark}
            onClick={() => theme(!dark)}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </header>
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="gallery" element={<Library key="gallery" />} />
          <Route path="jobs" element={<Library jobs key="jobs" />} />
          <Route path="groups" element={<Groups />} />
          <Route path="albums" element={<Groups albums />} />
          <Route path="settings" element={<Settings />} />
          <Route path="health" element={<Health />} />
          <Route path="*" element={<Link to="/">Return to dashboard</Link>} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
