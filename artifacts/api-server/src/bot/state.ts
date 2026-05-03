import type { UserState, UserPlan, UserStep } from './types';

const userStates = new Map<number, UserState>();

export function getUserState(userId: number): UserState {
  if (!userStates.has(userId)) {
    userStates.set(userId, { step: 'idle' });
  }
  return userStates.get(userId)!;
}

export function setUserState(userId: number, state: Partial<UserState>): void {
  const current = getUserState(userId);
  userStates.set(userId, { ...current, ...state });
}

export function clearUserState(userId: number): void {
  userStates.set(userId, { step: 'idle' });
}
