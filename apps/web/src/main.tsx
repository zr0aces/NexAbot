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
  Aperture,
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
import { api, query, labels } from "./data";
import { Dashboard, Groups, Settings, Health } from "./workspace";
import { Library } from "./photos";
import "./style.css";
const icons = [
  LayoutDashboard,
  Images,
  Layers,
  Users,
  CloudUpload,
  Gear,
  Activity,
];
const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
function Brand() {
  return (
    <div className="brand">
      <Aperture aria-hidden="true" /> NexAbot
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
          <small>PRIVATE PHOTO LIBRARY</small>
          <h1>
            Your groups.
            <br />
            One collection.
          </h1>
          <p>
            A private home for the photos your LINE groups send to Google
            Photos.
          </p>
        </div>
        <span>LINE → Google Photos</span>
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
  if (auth.error)
    return (
      <main role="alert">
        Cannot reach the gallery. Check the API connection.
      </main>
    );
  if (!auth.data) return <main>Opening library…</main>;
  if (!auth.data.authenticated) return <Login setup={auth.data.setup} />;
  return (
    <div className="shell">
      <aside>
        <Brand />
        <small>WORKSPACE</small>
        <nav>
          {Object.entries(labels).map(([k, v], i) => {
            const Icon = icons[i];
            return (
              <NavLink end key={k} to={k === "dashboard" ? "/" : "/" + k}>
                <Icon size={18} />
                {v}
              </NavLink>
            );
          })}
        </nav>
        <Button
          variant="ghost"
          onClick={async () => {
            await api("/auth/logout", "POST");
            qc.clear();
            location.assign("/");
          }}
        >
          <LogOut size={16} />
          Sign out
        </Button>
      </aside>
      <main className="workspace">
        <header>
          <span className="dot" /> Private workspace{" "}
          <span className="tz">Asia/Bangkok</span>
          <Button
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
