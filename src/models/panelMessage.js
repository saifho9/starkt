import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
  panelId: { type: mongoose.Schema.Types.ObjectId, required: true },
  settings: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true });
schema.index({ guildId: 1, messageId: 1 }, { unique: true });
export const PanelMessage = mongoose.model('PanelMessage', schema);
