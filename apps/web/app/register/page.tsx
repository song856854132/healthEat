"use client";

import Link from "next/link";
import { PASSWORD_MIN_LENGTH, RegisterInput } from "@healtheat/shared";
import { Field } from "../field";
import { FALLBACK_TIME_ZONE, browserTimeZone, firstPerField } from "../lib/form";
import { FormAlert, useAuthForm } from "../use-auth-form";
import type { Retry, Validate } from "../use-auth-form";

const FIELDS = ["username", "email", "password"] as const;

const validate: Validate = (data) => {
  const parsed = RegisterInput.safeParse({
    username: data.get("username"),
    email: data.get("email"),
    password: data.get("password"),
    timezone: browserTimeZone(),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const { timezone, ...fields } = firstPerField(
    parsed.error.flatten((i) => {
      if (i.path[0] === "email") return "Enter a valid email address.";
      if (i.path[0] === "password")
        return i.code === "too_big"
          ? "That password is too long."
          : `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
      return i.message; // the username rule is already worded for people
    }).fieldErrors,
  );
  // The time zone is not an input the user can fix; say so at form level.
  return {
    ok: false,
    errors: { form: timezone ? "Your browser reported an unknown time zone." : undefined, fields },
  };
};

// The browser and the API can disagree on a zone (one ICU knows "America/Ciudad_Juarez", the other
// not). The form has no time zone input, so retry once with UTC rather than block registration.
const retry: Retry = (body, invalidPaths) => {
  const sent = body as { timezone?: string };
  if (!invalidPaths.includes("timezone") || sent.timezone === FALLBACK_TIME_ZONE) return undefined;
  return { ...sent, timezone: FALLBACK_TIME_ZONE };
};

export default function RegisterPage() {
  const { errors, pending, onSubmit } = useAuthForm("/api/auth/register", FIELDS, validate, retry);

  return (
    <main>
      <h1>Create your account</h1>
      {/* method="post": a submit before hydration must not put the password in the URL. */}
      <form className="auth-form" method="post" onSubmit={onSubmit} noValidate>
        <FormAlert message={errors.form} />
        <Field
          name="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          error={errors.fields.username}
          hint="3 to 24 characters: lowercase letters, digits and underscore. It cannot be changed later."
        />
        <Field
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          error={errors.fields.email}
        />
        <Field
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          error={errors.fields.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        />
        <button
          type="submit"
          className="primary"
          disabled={pending}
          aria-busy={pending || undefined}
        >
          {pending ? "Creating account…" : "Create account"}
        </button>
        <p className="form-footer">
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </form>
    </main>
  );
}
