import { Onboarding } from "./onboarding";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Image as ImageIcon,
  CheckCircle,
  Clock,
  TriangleAlert,
} from "lucide-react";
import { Button } from "../../../packages/ui/button";
import {
  api,
  query,
  date,
  bytes,
  base,
  name,
  type Group,
  type Stats,
  type Settings as Prefs,
} from "./data";
export function Title({
  k,
  title,
  sub,
}: {
  k: string;
  title: string;
  sub: string;
}) {
  return (
    <section className="heading">
      <small>{k}</small>
      <h1>{title}</h1>
      <p>{sub}</p>
    </section>
  );
}
export function useAction() {
  const qc = useQueryClient(),
    [msg, set] = useState(""),
    [busy, lock] = useState(false);
  return {
    msg,
    busy,
    run: async (f: () => Promise<unknown>) => {
      lock(true);
      set("");
      try {
        await f();
        await qc.invalidateQueries();
        set("Saved.");
      } catch (e) {
        set((e as Error).message);
      } finally {
        lock(false);
      }
    },
  };
}
export function Dashboard() {
  const q = query<Stats>("/dashboard/stats"),
    prefs = query<Prefs>("/settings"),
    groups = query<Group[]>("/groups");
  if (!q.data) return <p>{q.error?.message ?? "Loading dashboard…"}</p>;
  const d = q.data;
  const cards = [
    ["Total images", d.total, ImageIcon],
    ["Synced", d.synced, CheckCircle],
    ["In progress", d.pending, Clock],
    ["Need attention", d.failed, TriangleAlert],
  ] as const;
  return (
    <>
      <Title
        k="LIBRARY OVERVIEW"
        title="Dashboard"
        sub="Collection activity across your authorized LINE groups."
      />
      <div className="metrics">
        {cards.map(([label, n, Icon]) => (
          <div key={label}>
            <Icon size={18} />
            <strong>{n}</strong>
            {label}
          </div>
        ))}
      </div>
      {(d.diskPressure || d.warnings > 0) && (
        <div className="warning" role="alert">
          {d.diskPressure ? "Low disk space. Ingestion is paused. " : ""}
          {d.warnings > 0 &&
            d.warnings +
              " staged images are approaching or past review deadlines. Originals have been retained."}{" "}
          <Link to="/jobs">Review queue</Link>
        </div>
      )}
      {(!d.synced || location.search === "?setup") && (
        <Onboarding stats={d} prefs={prefs.data} groups={groups.data ?? []} />
      )}
      <div className="columns">
        <section className="panel">
          <small>COLLECTION STATUS</small>
          <h2>Storage & connections</h2>
          {Object.entries({
            "Google Photos": d.google,
            "Active groups": d.groups,
            "Staged originals": bytes(d.stagingBytes),
            "Thumbnail cache": bytes(d.thumbnailBytes),
            "Available disk": bytes(d.freeBytes),
            "Oldest unuploaded": d.oldest ? date(d.oldest) : "None",
          }).map(([k, v]) => (
            <div className="row" key={k}>
              <span>{k}</span>
              <b>{v}</b>
            </div>
          ))}
        </section>
        <section className="panel">
          <small>EVENT LOG</small>
          <h2>Recent activity</h2>
          {d.recent.length ? (
            d.recent.map((e) => (
              <div className="row" key={e.id}>
                {e.action}
                <time>{date(e.createdAt)}</time>
              </div>
            ))
          ) : (
            <p>Connection and group changes will appear here.</p>
          )}
        </section>
      </div>
    </>
  );
}
export function Groups({ albums = false }: { albums?: boolean }) {
  const q = query<Group[]>("/groups"),
    action = useAction();
  return (
    <>
      <Title
        k="SOURCES"
        title={albums ? "Albums" : "LINE groups"}
        sub={
          albums
            ? "One Google Photos album for each collecting group."
            : "New groups stay paused until you enable collection."
        }
      />
      <p role="status">{action.msg || q.error?.message}</p>
      <div className="groupgrid">
        {q.data?.map((g) => (
          <article className="panel" key={g.id}>
            {albums && (
              <Link className="cover" to={"/gallery?group=" + g.lineGroupId}>
                {g.images[0] ? (
                  <img
                    loading="lazy"
                    src={
                      base + "/images/" + g.images[0].id + "/thumbnail?size=640"
                    }
                    alt={name(g) + " album cover"}
                  />
                ) : (
                  <ImageIcon />
                )}
              </Link>
            )}
            <small>
              {g.membershipStatus} · {g.enabled ? "COLLECTING" : "PAUSED"}
            </small>
            <h2>{name(g)}</h2>
            <p>
              {g._count.images} images ·{" "}
              {g.googleAlbumId
                ? "Album mapped"
                : g.albumCreating
                  ? "Mapping needs review"
                  : "No album yet"}
            </p>
            <p>
              {albums
                ? "Last image: " +
                  (g.images[0]
                    ? date(g.images[0].lineEventTimestamp) +
                      " · " +
                      g.images[0].uploadStatus
                    : "None")
                : "Last event: " + date(g.lastEventAt)}
            </p>
            {!albums && (
              <>
                <code>{g.googleAlbumId ?? g.lineGroupId}</code>
                {g.albumCreating && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      if (
                        window.confirm(
                          "Have you checked the destination account and confirmed this mapping? Leave the ID blank only if no album was created.",
                        )
                      )
                        void action.run(() =>
                          api("/groups/" + g.id + "/resolve-album", "POST", {
                            albumId: String(f.get("albumId") ?? ""),
                            confirmation: "I checked Google Photos",
                          }),
                        );
                    }}
                  >
                    <label>
                      Verified app-created album ID
                      <input name="albumId" />
                    </label>
                    <Button variant="secondary" disabled={action.busy}>
                      Resolve uncertain album
                    </Button>
                  </form>
                )}
                <Button
                  disabled={action.busy || g.membershipStatus === "LEFT"}
                  variant="secondary"
                  onClick={() =>
                    action.run(() =>
                      api("/groups/" + g.id, "PATCH", { enabled: !g.enabled }),
                    )
                  }
                >
                  {g.enabled ? "Pause collection" : "Enable collection"}
                </Button>
              </>
            )}
          </article>
        ))}
      </div>
      {q.data?.length === 0 && (
        <p className="empty">
          Invite the LINE bot to a group. Its album will appear here after the
          first authorized image.
        </p>
      )}
    </>
  );
}
export function Settings() {
  const q = query<Prefs>("/settings"),
    google = query<{ status: string; lastError?: string }>("/google/status"),
    action = useAction();
  if (!q.data) return <p>{q.error?.message ?? "Loading settings…"}</p>;
  const d = q.data;
  function save(e: FormEvent<HTMLFormElement>, kind: string) {
    e.preventDefault();
    const form = e.currentTarget,
      data = Object.fromEntries(new FormData(form));
    void action.run(async () => {
      await api(
        kind === "line" ? "/settings/line" : "/settings",
        kind === "line" ? "POST" : "PATCH",
        kind === "line"
          ? data
          : Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, Number(v)]),
            ),
      );
      if (kind === "line") form.reset();
    });
  }
  return (
    <>
      <Title
        k="ADMINISTRATION"
        title="Settings"
        sub="Manage the accounts, storage policies and webhook for this library."
      />
      <p role="status">{action.msg}</p>
      <div className="columns">
        <section className="panel">
          <small>DESTINATION</small>
          <h2>Google Photos</h2>
          <p>
            {google.data?.status} {google.data?.lastError}
          </p>
          <p>
            This integration sends personal images from enabled groups to your
            Google Photos account. It reads only app-created albums and media to
            verify uploads and display them privately.
          </p>
          <a className="button primary" href={base + "/google/connect"}>
            Connect Google Photos
          </a>{" "}
          <Button
            disabled={action.busy}
            variant="ghost"
            onClick={() => action.run(() => api("/google/validate", "POST"))}
          >
            Validate
          </Button>{" "}
          <Button
            disabled={action.busy}
            variant="ghost"
            onClick={() => action.run(() => api("/google/disconnect", "POST"))}
          >
            Disconnect
          </Button>
        </section>
        <form className="panel" onSubmit={(e) => save(e, "line")}>
          <small>GROUP SOURCE</small>
          <h2>LINE Messaging API</h2>
          <p>
            {d.lineConfigured
              ? "Credentials configured."
              : "Add the channel credentials to begin."}
          </p>
          <label>
            Access token
            <input name="token" type="password" required autoComplete="off" />
          </label>
          <label>
            Channel secret
            <input name="secret" type="password" required autoComplete="off" />
          </label>
          <Button disabled={action.busy}>Save credentials</Button>
          <p>Register this webhook URL in LINE Developers:</p>
          <code>{d.webhook}</code>
        </form>
        <form className="panel" onSubmit={(e) => save(e, "retention")}>
          <small>LOCAL CACHE</small>
          <h2>Retention policy</h2>
          {(
            [
              ["stagingHours", "Synced originals (hours)", 720],
              ["failedDays", "Failed original review deadline (days)", 90],
              ["thumbnailDays", "Thumbnail cache (days)", 365],
            ] as const
          ).map(([k, l, max]) => (
            <label key={k}>
              {l}
              <input
                name={k}
                type="number"
                min="1"
                max={max}
                required
                defaultValue={d[k]}
              />
            </label>
          ))}
          <p>
            Failed and uncertain originals are held for review, never silently
            discarded.
          </p>
          <Button disabled={action.busy}>Save retention</Button>
        </form>
      </div>
    </>
  );
}
export function Health() {
  const q = query<Record<string, string | boolean>>("/health");
  return (
    <>
      <Title
        k="OPERATIONS"
        title="System health"
        sub="Live dependency checks for ingestion and uploads."
      />
      <section className="panel">
        {q.error?.message}
        {Object.entries(q.data ?? {}).map(([k, v]) => (
          <div className="row" key={k}>
            <b>{k}</b>
            {String(v)}
          </div>
        ))}
      </section>
    </>
  );
}
