import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function NotFound() {
  return (
    <div className="bg-grid relative grid min-h-full place-items-center px-4">
      <div className="text-center">
        <p className="font-mono text-sm tracking-[0.2em] text-muted uppercase">Error 404</p>
        <h1 className="mt-2 font-display text-4xl font-900 text-ink">Route not found</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm text-muted">
          The page you asked for is not part of this console.
        </p>
        <Link to="/" className="mt-6 inline-block">
          <Button variant="outline">Back to the console</Button>
        </Link>
      </div>
    </div>
  );
}
