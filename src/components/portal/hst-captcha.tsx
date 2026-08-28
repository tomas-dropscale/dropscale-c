"use client";

import * as React from "react";

/**
 * HST's login captcha, drawn the way HST draws it.
 *
 * Their login page uses vue-pure-admin's `ReImageVerify`, which generates a
 * short code on a canvas IN THE BROWSER and sends it back as `captcha_code`
 * with an empty `captcha_key`. No challenge is issued by their server and none
 * can be checked by it — the only rule it enforces is that the field is not
 * empty, which is why signing in fails with "The captcha code field is
 * required" and nothing more.
 *
 * So there is nowhere to go and look the code up: it does not exist until a
 * browser draws it. This draws it here instead, and the person signing in reads
 * and types it exactly as they would on HST's own page. A constant lifted out
 * of somebody's captured request would have worked too, and is the one thing
 * not done here — presenting a challenge is not the same as answering it on
 * the vendor's behalf.
 *
 * The code lives in the PARENT so this component only ever paints: a captcha
 * that regenerates itself on every re-render of the form around it is a captcha
 * nobody can finish typing.
 */

// No 0/O, 1/I/l: a code nobody can read is a code nobody can type.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const LENGTH = 4;

/** A fresh code. Call it to seed state, and again to change the image. */
export function randomHstCaptcha(): string {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

export function HstCaptcha({ code, onRefresh }: { code: string; onRefresh: () => void }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#12100e";
    ctx.fillRect(0, 0, width, height);

    // Same idea as theirs: characters jittered and rotated so the code reads as
    // a challenge rather than as a label.
    for (let i = 0; i < code.length; i += 1) {
      ctx.save();
      ctx.translate(14 + i * 22, height / 2 + 7);
      ctx.rotate((Math.random() - 0.5) * 0.5);
      ctx.font = "700 22px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = `hsl(${38 + Math.random() * 14}, 70%, ${62 + Math.random() * 16}%)`;
      ctx.fillText(code[i], 0, 0);
      ctx.restore();
    }
    for (let i = 0; i < 4; i += 1) {
      ctx.strokeStyle = `rgba(212,175,110,${0.15 + Math.random() * 0.2})`;
      ctx.beginPath();
      ctx.moveTo(Math.random() * width, Math.random() * height);
      ctx.lineTo(Math.random() * width, Math.random() * height);
      ctx.stroke();
    }
  }, [code]);

  return (
    <button
      type="button"
      onClick={onRefresh}
      title="Click for a different code"
      aria-label="Captcha image. Click for a different code."
      className="overflow-hidden rounded-[8px] border border-[var(--border-subtle)] transition-smooth hover:border-[var(--accent-gold)]/40"
    >
      <canvas ref={canvasRef} width={104} height={40} className="block" />
    </button>
  );
}
