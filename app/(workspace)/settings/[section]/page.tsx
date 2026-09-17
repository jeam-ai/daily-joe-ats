import { Settings } from "@/components/settings";
export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  return <Settings section={(await params).section} />;
}
