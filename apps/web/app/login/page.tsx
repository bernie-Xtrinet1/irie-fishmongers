import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/login-form';

interface LoginPageProps {
  searchParams: Promise<{
    registered?: string | string[];
  }>;
}

export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const registered = params.registered === '1';

  return (
    <AuthShell
      title="Sign in"
      description="Sign in to shop fresh Jamaican seafood and manage your Irie Fishmongers account."
    >
      <LoginForm registered={registered} />
    </AuthShell>
  );
}
