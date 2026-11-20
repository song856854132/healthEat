"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { APP_NAME, PRIVACY_ACK_COOKIE } from "@healtheat/shared";
import { useAuth } from "./auth-context";

/** One year, as the design doc says ("Privacy policy on first visit") and routes/auth.ts sets it. */
const ACK_MAX_AGE_S = 365 * 24 * 60 * 60;

/** True when the browser holds a non-empty he_privacy_ack (the API treats any non-empty value as ack). */
export function hasPrivacyAck(cookie: string): boolean {
  return cookie
    .split(";")
    .map((part) => part.trim())
    .some(
      (part) =>
        part.startsWith(`${PRIVACY_ACK_COOKIE}=`) && part.length > PRIVACY_ACK_COOKIE.length + 1,
    );
}

function writeAckCookie() {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${PRIVACY_ACK_COOKIE}=1; Max-Age=${ACK_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
}

/**
 * The privacy notice on every page until acknowledged (design doc, "Privacy policy on first visit";
 * R3-9). The acknowledgment is the `he_privacy_ack` cookie, written here; register and login send it,
 * and the API copies it to `User.privacyAckAt`. On a new device the login answer sets the cookie again
 * when the account already acknowledged, and a signed-in account with `privacyAckAt` never sees the
 * banner either way.
 *
 * Read in the browser, not from the request: reading cookies in the layout would make every page
 * dynamic, /privacy and /about included. So nothing renders until the cookie has been read, and a
 * visitor who acknowledged never sees the banner flash in.
 */
export function PrivacyBanner() {
  const { me } = useAuth();
  // undefined until read in the browser.
  const [acked, setAcked] = useState<boolean | undefined>(undefined);
  const accountAcked = Boolean(me?.user.privacyAckAt);

  // Re-read on every session change: a login answer may just have set the cookie.
  useEffect(() => {
    setAcked(hasPrivacyAck(document.cookie));
  }, [me]);

  // An account that acknowledged elsewhere: mirror it into this browser so the banner stays away
  // after logout too.
  useEffect(() => {
    if (accountAcked && !hasPrivacyAck(document.cookie)) writeAckCookie();
  }, [accountAcked]);

  if (acked !== false || accountAcked) return null;

  function acknowledge() {
    writeAckCookie();
    setAcked(true);
  }

  return (
    <aside aria-label="Privacy notice" className="privacy-banner" data-testid="privacy-banner">
      <div className="privacy-banner-inner">
        <p>
          {APP_NAME} stores what you log; photos are analysed by Anthropic and not stored.{" "}
          <Link href="/privacy">Read the privacy policy</Link>.
        </p>
        <button type="button" onClick={acknowledge}>
          Got it
        </button>
      </div>
    </aside>
  );
}
