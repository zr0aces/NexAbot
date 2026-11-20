import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, X, Image as ImageIcon } from "lucide-react";
import { Button } from "../../../packages/ui/button";
import { states } from "../../../packages/shared/model";
import {
  api,
  base,
  bytes,
  date,
  name,
  query,
  type Group,
  type Photo,
  type Settings,
} from "./data";
import { Title, useAction } from "./workspace";
function Lightbox({
  items,
  index,
  set,
  close,
}: {
  items: Photo[];
  index: number;
  set: (n: number) => void;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  const p = items[index];
  return (
    <dialog
      className="viewer"
      ref={ref}
      onCancel={close}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") set(Math.max(0, index - 1));
        if (e.key === "ArrowRight") set(Math.min(items.length - 1, index + 1));
      }}
      aria-label="Image viewer"
    >
      <div className="row">
        <b>{name({ ...p.group, lineGroupId: p.lineGroupId })}</b>
        <Button aria-label="Close viewer" onClick={close}>
          <X />
        </Button>
      </div>
      <img
        src={base + "/images/" + p.id + "/content"}
        alt={"Photo received " + date(p.lineEventTimestamp)}
      />
      <div className="row">
        <Button
          aria-label="Previous image"
          disabled={!index}
          onClick={() => set(index - 1)}
        >
          <ChevronLeft />
        </Button>
        <span>
          {index + 1} / {items.length}
        </span>
        <Button
          aria-label="Next image"
          disabled={index + 1 === items.length}
          onClick={() => set(index + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
      <p>
        {date(p.lineEventTimestamp)} · {p.width} × {p.height} ·{" "}
        {bytes(p.fileSize ?? 0)} · {p.mimeType} · {p.uploadStatus}
      </p>
      {p.productUrl?.startsWith("https://photos.google.com/") && (
        <a href={p.productUrl} target="_blank" rel="noreferrer">
          Open in Google Photos ↗
        </a>
      )}
    </dialog>
  );
}
export function Library({ jobs = false }: { jobs?: boolean }) {
  const [sp, setParams] = useSearchParams(),
    [index, setIndex] = useState<number | null>(null);
  const prefs = query<Settings>("/settings"),
    action = useAction(),
    groups = query<Group[]>("/groups"),
    q = query<{ items: Photo[]; total: number; page: number }>(
      (jobs ? "/jobs" : "/images") + "?" + sp,
    );
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(sp);
    if (k !== "page") p.delete("page");
    if (v) p.set(k, v);
    else p.delete(k);
    setIndex(null);
    setParams(p);
  };
  const d = q.data;
  return (
    <>
      <Title
        k={jobs ? "OPERATIONS" : "PHOTO LIBRARY"}
        title={jobs ? "Upload queue" : "Gallery"}
        sub={
          jobs
            ? "Track processing, retry failed uploads and reconcile uncertain results."
            : "Photos received from your authorized LINE groups."
        }
      />
      <div className="filters">
        <label>
          Group
          <select
            value={sp.get("group") ?? ""}
            onChange={(e) => set("group", e.target.value)}
          >
            <option value="">All groups</option>
            {groups.data?.map((g) => (
              <option key={g.id} value={g.lineGroupId}>
                {name(g)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={sp.get("status") ?? ""}
            onChange={(e) => set("status", e.target.value)}
          >
            <option value="">All states</option>
            {states
              .filter((s) => !jobs || s !== "SYNCED")
              .map((s) => (
                <option key={s}>{s}</option>
              ))}
          </select>
        </label>
        {["from", "to"].map((k) => (
          <label key={k}>
            {k === "from" ? "From" : "Through"}
            <input
              type="date"
              value={sp.get(k) ?? ""}
              onChange={(e) => set(k, e.target.value)}
            />
          </label>
        ))}
      </div>
      <p role="status">{action.msg || q.error?.message}</p>
      {d && (
        <>
          <div className="row">
            <small>
              {d.total} {jobs ? "JOBS" : "IMAGES"}
            </small>
            <span>Newest first</span>
          </div>
          {!d.total ? (
            <div className="empty">
              <ImageIcon />
              <h2>{jobs ? "Queue is clear" : "No images found"}</h2>
              <p>
                {jobs
                  ? "Unfinished uploads will appear here."
                  : "Try a different filter or send a new image to an enabled group."}
              </p>
            </div>
          ) : (
            <div className={jobs ? "queue" : "photos"}>
              {d.items.map((p, i) =>
                jobs ? (
                  <article className="panel" key={p.id}>
                    <small>{p.uploadStatus}</small>
                    <h3>{name({ ...p.group, lineGroupId: p.lineGroupId })}</h3>
                    <time>{date(p.lineEventTimestamp)}</time>
                    <p>
                      {p.errorCode} {p.lastError}
                    </p>
                    {["FAILED", "NEEDS_REVIEW"].includes(p.uploadStatus) && (
                      <Button
                        disabled={action.busy}
                        onClick={() =>
                          action.run(() =>
                            api("/jobs/" + p.id + "/retry", "POST"),
                          )
                        }
                      >
                        {p.uploadStatus === "NEEDS_REVIEW"
                          ? "Reconcile with Google"
                          : "Retry upload"}
                      </Button>
                    )}
                    {p.hasStaging &&
                      prefs.data &&
                      ["FAILED", "UNRECOVERABLE", "NEEDS_REVIEW"].includes(
                        p.uploadStatus,
                      ) &&
                      Date.now() - Date.parse(p.createdAt) >=
                        prefs.data.failedDays * 86400000 && (
                        <Button
                          variant="ghost"
                          disabled={action.busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                "Permanently discard this expired local original? If no Google copy exists, this image cannot be recovered.",
                              )
                            )
                              void action.run(() =>
                                api("/jobs/" + p.id + "/discard", "POST", {
                                  confirmation: "Discard staged original",
                                }),
                              );
                          }}
                        >
                          Discard expired original
                        </Button>
                      )}
                  </article>
                ) : (
                  <button
                    className="photo"
                    key={p.id}
                    onClick={() => setIndex(i)}
                  >
                    <img
                      loading="lazy"
                      src={base + "/images/" + p.id + "/thumbnail?size=640"}
                      alt={
                        "Photo from " +
                        name({ ...p.group, lineGroupId: p.lineGroupId })
                      }
                    />
                    <b>{name({ ...p.group, lineGroupId: p.lineGroupId })}</b>
                    <time>{date(p.lineEventTimestamp)}</time>
                  </button>
                ),
              )}
            </div>
          )}
          <footer>
            <Button
              variant="secondary"
              disabled={d.page <= 1}
              onClick={() => set("page", String(d.page - 1))}
            >
              Previous
            </Button>{" "}
            Page {d.page}{" "}
            <Button
              variant="secondary"
              disabled={d.page * 36 >= d.total}
              onClick={() => set("page", String(d.page + 1))}
            >
              Next
            </Button>
          </footer>
          {index !== null && d.items[index] && (
            <Lightbox
              items={d.items}
              index={index}
              set={setIndex}
              close={() => setIndex(null)}
            />
          )}
        </>
      )}
    </>
  );
}
