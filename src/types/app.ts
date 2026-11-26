export interface AppSettings {
  appName: string;
  logoUrl: string;
  iconUrl: string;
  bannerUrl: string;
  primaryColor: string;
  bgColor: string;
  maintenanceMode: string;
  registrationEnabled: string;
  defaultLanguage: string;
  pointsPerBdt: string;
  minWithdrawalPoints: string;
  maxWithdrawalPoints: string;
  withdrawalFeePercent: string;
  dailyCheckinReward: string;
  dailyMaxAdEarnings: string;
  referralRewardPoints: string;
  referralInviteeBonus: string;
  referralConditionMinTasks: string;
  referralMaxLevels: string;
  referralLevel2Percent: string;
  supportUrl: string;
  channelUrl: string;
  botUsername: string;
  termsText: string;
  privacyText: string;
  adsEnabled?: string;
  checkinEnabled?: string;
  tasksEnabled?: string;
  gamesEnabled?: string;
  referralsEnabled?: string;
  withdrawalsEnabled?: string;
  [key: string]: string | undefined;
}

export interface UserProfile {
  id: number;
  telegramId: string;
  username: string;
  firstName: string;
  lastName: string;
  photoUrl: string;
  isOnline: boolean;
  pointsBalance: number;
  pendingBalance: number;
  totalEarned: number;
  totalWithdrawn: number;
  referralCode: string;
  referralEarnings: number;
  isPreview: boolean;
  language: string;
}

export interface LanguageItem {
  code: string;
  name: string;
  native_name: string;
  is_enabled: number;
}

export interface AdSlot {
  slotNumber: number;
  rewardPoints: number;
  status: 'available' | 'initiated' | 'verified' | 'expired';
  sessionId: string | null;
}

export interface AdProgram {
  providerId: number;
  providerName: string;
  providerType: string;
  rewardPoints: number;
  dailyLimit: number;
  completedToday: number;
  remainingToday: number;
  earnedToday: number;
  dailyMaxAdEarnings: number;
  nextResetIso: string;
  slots: AdSlot[];
}

export interface TaskItem {
  id: number;
  title: string;
  description: string;
  category: 'youtube' | 'social' | 'daily' | 'custom' | 'partner' | 'special_offer';
  icon_url: string;
  target_url: string;
  reward_points: number;
  verification_type: 'admin_approval' | 'code_verify' | 'postback';
  daily_limit: number;
  expires_at: string;
  todayCount: number;
  latestStatus: 'pending' | 'approved' | 'rejected' | null;
  reviewNote: string;
}

export interface GameItem {
  id: number;
  slug: string;
  game_type?: string;
  title: string;
  description: string;
  icon_url: string;
  target_url?: string;
  reward_min: number;
  reward_max: number;
  daily_limit: number;
  cooldown_seconds: number;
  playsToday: number;
  playsLeft: number;
  cooldownRemaining: number;
}

export interface WithdrawalMethod {
  id: number;
  name: string;
  code: string;
  networks: string[];
  min_points: number;
  max_points: number;
  fee_percent: number;
}

export interface WithdrawalRecord {
  id: number;
  method_name: string;
  network: string;
  account_address: string;
  points_amount: number;
  fee_points: number;
  net_points: number;
  bdt_amount: number;
  fee_bdt: number;
  net_bdt: number;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  admin_note: string;
  tx_hash: string;
  created_at: string;
}

export interface TransactionRecord {
  id: number;
  type: string;
  amount_points: number;
  balance_after: number;
  description: string;
  reference_id: string;
  created_at: string;
}

export interface ReferralRecord {
  id: number;
  username: string;
  first_name: string;
  referral_qualified: number;
  created_at: string;
}

export interface BootstrapPayload {
  settings: AppSettings;
  user: UserProfile;
  languages: LanguageItem[];
  i18n: Record<string, string>;
  dailyStats: {
    earnedToday: number;
    dailyMaxEarnings?: number;
    checkinClaimedToday: boolean;
    nextResetIso: string;
  };
  adProgram: AdProgram | null;
  tasks: TaskItem[];
  games: GameItem[];
  withdrawalMethods: WithdrawalMethod[];
  withdrawals: WithdrawalRecord[];
  transactions: TransactionRecord[];
  referrals: ReferralRecord[];
}

export type MiniTab = 'home' | 'earn' | 'play' | 'refer' | 'account';
