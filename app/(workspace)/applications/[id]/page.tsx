import { ApplicantProfile } from "@/components/applicant-profile";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApplicantProfile key={id} id={id} />;
}
