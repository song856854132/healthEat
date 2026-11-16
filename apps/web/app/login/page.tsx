"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { LoginInput } from "@healtheat/shared";
import { useAuth } from "../auth-context";
import { Field } from "../field";
import { postAuth } from "../lib/api";
import type { FormErrors } from "../lib/api";
import { issuesToFieldErrors } from "../lib/form";

export default function LoginPage() {
  const { me, setMe } = useAuth();
  const router = useRouter();
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (me) router.replace("/");
  }, [me, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const parsed = LoginInput.safeParse({
      username: data.get("username"),
      password: data.get("password"),
    });
    if (!parsed.success) {
      setErrors({
        fields: issuesToFieldErrors(parsed.error.issues, {
          username: (i) => (i.code === "too_big" ? undefined : "Enter your username."),
          password: (i) => (i.code === "too_big" ? undefined : "Enter your password."),
        }),
      });
      return;
    }
    setPending(true);
    setErrors({ fields: {} });
    const result = await postAuth("/api/auth/login", parsed.data);
    setPending(false);
    if (result.ok) setMe(result.me);
    else setErrors(result.errors);
  }

  return (
    <main>
      <h1>Log in</h1>
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        {errors.form ? (
          <p role="alert" className="form-error">
            {errors.form}
          </p>
        ) : null}
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
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Logging in…" : "Log in"}
        </button>
        <p className="form-footer">
          New here? <Link href="/register">Create an account</Link>
        </p>
      </form>
    </main>
  );
}
