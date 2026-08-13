const mongoose = require('mongoose');

const PetpoojaConfigSchema = new mongoose.Schema(
  {
    userId: { type: Number },
    organizationId: { type: Number },
    accessToken: { type: String },
    refreshToken: { type: String },
    accessTokenExpiresAt: { type: Date },
    refreshTokenExpiresAt: { type: Date },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PetpoojaConfig', PetpoojaConfigSchema);
