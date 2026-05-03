export type UserPlan = 'plus' | 'business';

export type UserStep =
  | 'idle'
  | 'waiting_email'
  | 'waiting_otp'
  | 'waiting_confirmation'
  | 'processing';

export interface UserState {
  step: UserStep;
  plan?: UserPlan;
  email?: string;
  paymentLink?: string;
  messageId?: number;
}
