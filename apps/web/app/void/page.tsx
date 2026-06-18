import { notFound } from "next/navigation";
import VoidExperience from "./VoidExperience";

// Easter-egg route. The campaign is over, so it's disabled on the live site:
// in production this route 404s. It stays fully playable in local dev
// (`next dev`) — flip nothing, just run locally. To re-enable in prod, remove
// the guard below (and re-arm the trigger via SHOW_VOID_EGG in Footer.tsx).
export default function VoidPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <VoidExperience />;
}
