"use client";

import Link from "next/link";
import { useT } from "@/i18n";

export default function NotFound() {
  const t = useT();
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: "#0a0a0c", color: "#ffffff" }}
    >
      <div className="text-center px-6">
        {/* Glitchy 404 */}
        <div className="relative mb-6">
          <h1
            className="text-[120px] sm:text-[180px] font-black tracking-wider leading-none"
            style={{
              fontFamily: "var(--font-display)",
              color: "#39c5bb",
              textShadow: "4px 0 #ff2d7a, -4px 0 #00ffe5",
            }}
          >
            404
          </h1>
        </div>

        {/* Status line */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-2 h-2 bg-[#ff2d7a]" />
          <span
            className="text-xs font-mono uppercase tracking-[0.4em]"
            style={{ color: "#ff2d7a" }}
          >
            {t('notFound.status')}
          </span>
        </div>

        {/* Description */}
        <p
          className="text-base font-mono mb-8 max-w-md mx-auto"
          style={{ color: "#888892" }}
        >
          {t('notFound.desc1')}
          <br />
          {t('notFound.desc2')}
        </p>

        {/* Actions */}
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Link
            href="/"
            className="px-6 py-3 font-bold uppercase tracking-wider text-sm flex items-center gap-2 transition-colors"
            style={{ backgroundColor: "#39c5bb", color: "#0a0a0c" }}
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            {t('notFound.returnHome')}
          </Link>
          <Link
            href="/docs"
            className="px-6 py-3 font-bold uppercase tracking-wider text-sm border transition-colors"
            style={{ borderColor: "#2a2a30", color: "#888892" }}
          >
            {t('notFound.documentation')}
          </Link>
        </div>

        {/* Terminal footer */}
        <div
          className="mt-16 font-mono text-xs"
          style={{ color: "#555560" }}
        >
          <span style={{ color: "#39c5bb" }}>{">"}</span> PROX // ERROR
          404
        </div>
      </div>
    </div>
  );
}
