import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/login-form';

interface LoginPageProps {
  searchParams: Promise<{
    registered?: string | string[];
    returnUrl?: string | string[];
  }>;
}

function safeReturnUrl(value: string | string[] | undefined): string {
  if (typeof value !== 'string') {
    return '/';
  }

  if (!value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }

  return value;
}

export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const registered = params.registered === '1';
  const returnUrl = safeReturnUrl(params.returnUrl);

  return (
    <AuthShell
      title="Sign in"
      description="Sign in to shop fresh Jamaican seafood and manage your Irie Fishmongers account."
    >
      <LoginForm registered={registered} returnUrl={returnUrl} />
    </AuthShell>
  );
}
