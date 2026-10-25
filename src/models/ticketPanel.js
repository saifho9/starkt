import mongoose from 'mongoose';

const menuOptionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    value: { type: String, required: true },
    description: { type: String, default: '' },
    ticketCategoryId: { type: String },
    staffRoleIds: { type: [String], default: undefined }
  },
  { _id: false }
);

const ticketPanelSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    name: { type: String, default: '' },
    recoveredFromMessageId: { type: String },
    legacyPanelId: { type: String },
    needsReview: { type: Boolean, default: false },
    recoveryNote: { type: String, default: '' },
    channelId: { type: String, required: true },
    messageId: { type: String },
    embedTitle: { type: String, required: true },
    embedDescription: { type: String, required: true },
    embedColor: { type: Number, default: 0x5865f2 },
    embedImageUrl: { type: String },
    ticketMessage: { type: String, default: '' },
    selectPlaceholder: { type: String },
    panelContent: { type: String },
    claimLogChannelId: { type: String },
    closeLogChannelId: { type: String },
    ticketCategoryId: { type: String },
    staffRoleIds: { type: [String], default: [] },
    menuOptions: { type: [menuOptionSchema], default: [] }
  },
  { timestamps: true }
);

ticketPanelSchema.index({ guildId: 1, channelId: 1 });
ticketPanelSchema.index({ guildId: 1, recoveredFromMessageId: 1 }, {
  unique: true, partialFilterExpression: { recoveredFromMessageId: { $type: 'string' } }
});

export const TicketPanel = mongoose.model('TicketPanel', ticketPanelSchema);
