const { StaticContent } = require("../../models/staticContentModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
module.exports.getStaticContent = async (req, res) => {
  try {
    // console.log('Req hit');
    // const {title} =req.body;
    const title = req.body?.title || req.query?.title;
    console.log(req.body);
    if (!title) {
      return res.status(400).send({ code: 400, message: "Title is required" });
    }
    const content = await StaticContent.findOne({ title: title });
    console.log(">>>>>>>>", content);
    if (!content) {
      return res.send({ code: 400, message: "Content not found" });
    }
    res.send({ code: 200, data: content, message: "Content found" });
  } catch (error) {
    res.status(500).send({ message: "Oops! Something went wrong" });
  }
};
exports.getStaticContentByRole = catchAsyncError(async (req, res) => {
  const content = await StaticContent.find({ role: req.query.role });
  if (!content || content.length === 0) {
    return res.send({ code: 400, message: "Content not found" });
  }
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Content found",
    data: content,
  });
})

module.exports.editStaticContent = async (req, res) => {
  try {
    const { title, content } = req.body;
    // console.log(req.body);
    const foundContent = await StaticContent.findOneAndUpdate(
      { title: title },
      { content: content },
      { new: true, runValidators: true }
    );
    if (!foundContent) {
      return res.status(404).send({ message: "Content not found" });
    }
    return res.send({ code: 200, data: foundContent });
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
};
