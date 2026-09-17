import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { demoEnabled } from "@/lib/server/config";
import { Shell } from "@/components/shell";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  const demo = demoEnabled();
  if (!user) redirect("/login");
  return (
    <Shell email={user?.email} demo={false}>
      {children}
    </Shell>
  );
}
