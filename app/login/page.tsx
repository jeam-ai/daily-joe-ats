import Link from "next/link";
import Image from "next/image";
import { Coffee, ArrowRight, ShieldCheck } from "lucide-react";
import { demoEnabled } from "@/lib/server/config";
const errors: Record<string, string> = {
  state:
    "Your sign-in request expired or could not be verified. Please try again.",
  unauthorized:
    "This Google account is not authorized for Daily Joe Careers. Contact your workspace administrator.",
  denied: "Google authorization was canceled. You can try again when ready.",
  scope:
    "The required Gmail permission was not granted. Reconnect to try again.",
  signin: "Sign in before connecting Gmail.",
  authorization:
    "We couldn’t complete Google sign-in. Please try again or contact your workspace administrator.",
};
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="login-page">
      <div className="login-story">
        <Link className="brand" href="/">
          <Image
            className="brand-logo"
            src="/daily-joe-logo-blue.png"
            alt="Daily Joe Careers"
            width={220}
            height={96}
            priority
          />
          <span className="brand-careers">CAREERS</span>
        </Link>
        <div>
          <div className="eyebrow">THE PEOPLE BEHIND EVERY CUP</div>
          <h1>
            Good people.
            <br />
            Great beginnings.
          </h1>
          <p>
            A little care can start something wonderful.
            <br />A clear next step for every applicant.
          </p>
          <Coffee size={50} strokeWidth={1} />
        </div>
        <small>DAILY JOE CAREERS · PEOPLE & CULTURE</small>
      </div>
      <div className="login-form">
        <div>
          <span className="eyebrow">YOUR RECRUITMENT WORKSPACE</span>
          <h1>Welcome back</h1>
          <p>Sign in to Daily Joe Careers</p>
          {error && (
            <div className="error-banner" role="alert">
              {errors[error] || errors.authorization}
            </div>
          )}
          <a href="/api/auth/google" className="button google-button">
            <b>G</b>Continue with Google
            <ArrowRight size={18} />
          </a>
          <p className="fine-print">
            <ShieldCheck size={15} />
            Internal recruitment operations · Authorized Google accounts only.
          </p>
        </div>
      </div>
    </div>
  );
}
