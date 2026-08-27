import { useEffect } from 'react';
import { useRouter } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';
import { LoginScreen } from './(auth)/login';

export default function AddAccountScreen() {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.loginState?.step === 'completed') router.replace('/devices');
  }, [auth.loginState?.step, router]);

  return (
    <LoginScreen
      additionalAccount
      onClose={() => {
        void auth.cancelAddAccount().finally(() => router.replace('/devices'));
      }}
    />
  );
}
