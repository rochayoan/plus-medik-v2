"use server";

import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

export async function signOut(): Promise<void> {
  await (await createUserClient()).auth.signOut();
  redirect("/login");
}
