import type { Metadata } from "next";
import { APP_NAME } from "@healtheat/shared";
import { ProfileView } from "./profile-view";

export const metadata: Metadata = {
  title: `Your profile · ${APP_NAME}`,
  description: "Your account, your sharing choices and phone number, and deleting your account.",
};

/**
 * /profile (design doc, Pages table: own profile, sensitive fields visible; anonymous visitors are
 * sent to log in). The account is only known in the browser, so the page is a client view.
 */
export default function ProfilePage() {
  return <ProfileView />;
}
