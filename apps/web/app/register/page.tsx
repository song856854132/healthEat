"use client";

import Link from "next/link";
import { PASSWORD_MIN_LENGTH, RegisterInput } from "@healtheat/shared";
import { Field } from "../field";
import { browserTimeZone, issuesToFieldErrors } from "../lib/form";
import { FormAlert, useAuthForm } from "../use-auth-form";
import type { Validate } from "../use-auth-form";

const FIELDS = ["username", "email", "password"] as const;

const validate: Validate = (data) => {
  const parsed = RegisterInput.safeParse({
    username: data.get("username"),
    email: data.get("email"),
    password: data.get("password"),
    timezone: browserTimeZone(),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const { timezone, ...fields } = issuesToFieldErrors(parsed.error.issues, {
    email: () => "Enter a valid email address.",
    password: (i) =>
      i.code === "too_big"
        ? "That password is too long."
        : `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  });
  // The time zone is not an input the user can fix; say so at form level.
  return {
    ok: false,
    errors: { form: timezone ? "Your browser reported an unknown time zone." : undefined, fields },
  };
};

export default function RegisterPage() {
  const { errors, pending, onSubmit } = useAuthForm("/api/auth/register", FIELDS, validate);

  return (
    <main>
      <h1>Create your account</h1>
      <form className="auth-form" onSubmit={onSubmit} noValidate>
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
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </button>
        <p className="form-footer">
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </form>
    </main>
  );
}
