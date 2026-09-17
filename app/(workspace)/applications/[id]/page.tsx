import { ApplicantProfile } from "@/components/applicant-profile";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <ApplicantProfile id={(await params).id} />;
}
