const mongoose = require("mongoose");
const storeClosureSchema = new mongoose.Schema({
  closureDate:{ type:String },
  closureType:{ type:String },
},
{ timestamps: true });

module.exports = mongoose.model("StoredClosure", storeClosureSchema);