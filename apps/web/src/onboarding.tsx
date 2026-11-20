import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "../../../packages/ui/button";
import type { Stats, Settings, Group } from "./data";
export function Onboarding({
  stats,
  prefs,
  groups,
}: {
  stats: Stats;
  prefs?: Settings;
  groups: Group[];
}) {
  const steps = [
    [
      "Create the owner account",
      "You are signed in as the only owner.",
      "/",
      "Dashboard",
      true,
    ],
    [
      "Configure LINE credentials",
      "Enter the access token and channel secret for your LINE Official Account.",
      "/settings",
      "Open settings",
      prefs?.lineConfigured,
    ],
    [
      "Register the webhook URL",
      "Paste the URL below into LINE Developers. Select Verify, then turn on webhooks and redelivery.",
      "/settings",
      "View configuration",
      groups.length > 0,
    ],
    [
      "Connect Google Photos",
      "Authorize both Photos permissions for the personal account that will own these albums.",
      "/settings",
      "Connect account",
      stats.google === "CONNECTED",
    ],
    [
      "Invite the bot to a group",
      "Enable group participation in LINE Developers, then invite the Official Account from LINE.",
      "/groups",
      "View groups",
      groups.length > 0,
    ],
    [
      "Enable collection",
      "Tell the group what will be collected. Enable only groups whose photos belong in your personal collection.",
      "/groups",
      "Manage groups",
      stats.groups > 0,
    ],
    [
      "Send a test image",
      "Send a new image in an enabled group. Old messages, videos, rooms and direct messages are not collected.",
      "/jobs",
      "Monitor queue",
      stats.total > 0,
    ],
    [
      "Verify the upload",
      "Wait for a synced image. If the upload stops, check the queue for the provider error.",
      "/jobs",
      "Inspect queue",
      stats.synced > 0,
    ],
    [
      "Open the image",
      "Your synced image is now available in the private gallery.",
      "/gallery",
      "Open gallery",
      stats.synced > 0,
    ],
  ] as const;
  const [manual, choose] = useState<number | null>(null);
  const first = steps.findIndex((x) => !x[4]);
  const step = manual ?? (first < 0 ? 8 : first),
    current = steps[step];
  return (
    <section className="panel">
      <small>FIRST COLLECTION · STEP {step + 1} OF 9</small>
      <h2>{current[0]}</h2>
      <p>{current[1]}</p>
      {step === 2 && <code>{prefs?.webhook}</code>}
      <Link to={current[2]}>{current[3]} ↗</Link>
      <div className="row">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => choose(step - 1)}
        >
          Back
        </Button>
        <progress aria-label="Setup progress" max={9} value={step + 1} />
        {step < 8 ? (
          <Button variant="secondary" onClick={() => choose(step + 1)}>
            Next <ArrowRight size={14} />
          </Button>
        ) : (
          <Link to="/gallery">Finish</Link>
        )}
      </div>
    </section>
  );
}
