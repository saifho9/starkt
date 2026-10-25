import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  channelId: { type: String },
  ownerId: { type: String, required: true },
  panelId: { type: mongoose.Schema.Types.ObjectId },
  selectedValue: { type: String, default: '' },
  selectedLabel: { type: String, default: '' },
  staffRoleIds: { type: [String], default: [] },
  settings: { type: mongoose.Schema.Types.Mixed },
  openingMessageId: { type: String },
  activeKey: { type: String },
  claimedBy: { type: String, default: null },
  claimedAt: { type: Date },
  state: { type: String, enum: ['opening', 'open', 'closing', 'closed'], default: 'opening' },
  closedAt: { type: Date }
}, { timestamps: true });
schema.index({ channelId: 1 }, { unique: true, sparse: true });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
export const Ticket = mongoose.model('Ticket', schema);
