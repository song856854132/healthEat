"use client";

import Link from "next/link";
import { LoginInput } from "@healtheat/shared";
import { Field } from "../field";
import { firstPerField } from "../lib/form";
import { FormAlert, useAuthForm } from "../use-auth-form";
import type { Validate } from "../use-auth-form";

const FIELDS = ["username", "password"] as const;

const validate: Validate = (data) => {
  const parsed = LoginInput.safeParse({
    username: data.get("username"),
    password: data.get("password"),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    errors: {
      fields: firstPerField(
        parsed.error.flatten((i) => {
          if (i.code === "too_big") return i.message;
          return i.path[0] === "password" ? "Enter your password." : "Enter your username.";
        }).fieldErrors,
      ),
    },
  };
};

export default function LoginPage() {
  const { errors, pending, onSubmit } = useAuthForm("/api/auth/login", FIELDS, validate);

  return (
    <main>
      <h1>Log in</h1>
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
        />
        <Field
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          error={errors.fields.password}
        />
        <button
          type="submit"
          className="primary"
          disabled={pending}
          aria-busy={pending || undefined}
        >
          {pending ? "Logging in…" : "Log in"}
        </button>
        <p className="form-footer">
          New here? <Link href="/register">Create an account</Link>
        </p>
      </form>
    </main>
  );
}
