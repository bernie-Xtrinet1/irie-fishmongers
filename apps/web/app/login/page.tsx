import { AuthShell } from '@/components/auth/auth-shell';
import { LoginForm } from '@/components/auth/login-form';

export default function LoginPage(): React.ReactElement {
  return (
    <AuthShell
      title="Sign in"
      description="Sign in to shop fresh Jamaican seafood and manage your Irie Fishmongers account."
    >
      <LoginForm />
    </AuthShell>
  );
}
