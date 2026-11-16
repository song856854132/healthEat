"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { PASSWORD_MIN_LENGTH, RegisterInput } from "@healtheat/shared";
import { useAuth } from "../auth-context";
import { Field } from "../field";
import { postAuth } from "../lib/api";
import type { FormErrors } from "../lib/api";
import { browserTimeZone, issuesToFieldErrors } from "../lib/form";

export default function RegisterPage() {
  const { me, setMe } = useAuth();
  const router = useRouter();
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [pending, setPending] = useState(false);

  // Already signed in (or just registered): this page has nothing to offer.
  useEffect(() => {
    if (me) router.replace("/");
  }, [me, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const parsed = RegisterInput.safeParse({
      username: data.get("username"),
      email: data.get("email"),
      password: data.get("password"),
      timezone: browserTimeZone(),
    });
    if (!parsed.success) {
      const fields = issuesToFieldErrors(parsed.error.issues, {
        email: () => "Enter a valid email address.",
        password: (i) =>
          i.code === "too_big"
            ? "That password is too long."
            : `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
      });
      // The time zone is not a field the user can fix; say so at form level.
      const { timezone, ...rest } = fields;
      setErrors({
        form: timezone ? "Your browser reported an unknown time zone." : undefined,
        fields: rest,
      });
      return;
    }
    setPending(true);
    setErrors({ fields: {} });
    const result = await postAuth("/api/auth/register", parsed.data);
    setPending(false);
    if (result.ok) setMe(result.me);
    else setErrors(result.errors);
  }

  return (
    <main>
      <h1>Create your account</h1>
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
