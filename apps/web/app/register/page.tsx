import { AuthShell } from '@/components/auth/auth-shell';
import { RegisterForm } from '@/components/auth/register-form';

export default function RegisterPage(): React.ReactElement {
  return (
    <AuthShell
      title="Create your account"
      description="Join Irie Fishmongers as a customer or marketplace participant."
    >
      <RegisterForm />
    </AuthShell>
  );
}
