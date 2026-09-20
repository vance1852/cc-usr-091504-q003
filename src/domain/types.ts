/** 领域共享类型与枚举定义。 */

/** 保管条件（家长提交，校方按此存放；存放状态失效则冻结）。 */
export type StorageRequirement = 'room_temp' | 'refrigerated' | 'cool_dark';

/** 授权（书面指示）状态。 */
export type AuthStatus = 'active' | 'superseded' | 'expired';

/** 药品整体生命周期状态。 */
export type MedicationStatus =
  | 'intake_pending' // 已登记待校方接收
  | 'in_custody' // 在校保管中，可按指示执行
  | 'frozen' // 存在冲突/破损/授权问题，冻结执行
  | 'returned' // 已退回家长
  | 'depleted'; // 数量耗尽

/** 冻结原因，写入 freeze_reason 并产生通知。 */
export type FreezeReason =
  | 'info_conflict' // 药盒标签与线上指示剂量不一致等信息冲突
  | 'auth_expired' // 授权到期
  | 'package_damaged' // 包装破损
  | 'storage_breach' // 保管条件失效（如冷链中断）
  | 'instruction_change_pending'; // 家长提交了新指示版本，待重新双人核对

/** 双人核对结果。 */
export type VerificationStatus = 'verified' | 'conflict';

export interface WrittenInstruction {
  /** 药品通用名/商品名，需与包装一致。 */
  drugName: string;
  /** 剂型，如 tablet / liquid。 */
  form: string;
  /** 每次剂量的书面描述，例如 "5ml"、"1片"。校方不做剂量判断，仅比对一致性。 */
  doseText: string;
  /** 给药途径，如 oral。 */
  route: string;
  /** 计划执行时间点（HH:MM，本地时间），例如 ["16:30"]。 */
  scheduledTimes: string[];
  /** 授权生效日期 YYYY-MM-DD。 */
  validFrom: string;
  /** 授权失效日期 YYYY-MM-DD（含当日）。 */
  validUntil: string;
  /** 附加说明，例如 "饭后服用"。 */
  notes?: string;
}

/** 动作幂等键携带的动作类型。 */
export type ActionType =
  | 'receive'
  | 'verify'
  | 'handoff'
  | 'execute'
  | 'return'
  | 'freeze'
  | 'unfreeze'
  | 'incident';

/** 差错/异常事件类型（只能追加，不能修改或删除执行记录）。 */
export type IncidentType =
  | 'missed_dose' // 漏执行
  | 'student_refused' // 学生拒绝
  | 'dose_deviation' // 剂量/时间误差
  | 'package_damaged' // 包装破损
  | 'storage_breach' // 保管条件失效
  | 'other';
