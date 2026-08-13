const Issue =require("../../models/issueModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");

exports.createIssue = catchAsyncError(async (req, res) => {
  const { issueName } = req.body;

  if (!issueName) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Issue name is required",
    });
  }

  const issue = await Issue.create({ issueName });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Issue created successfully",
    data: issue,
  });
});
exports.getAllIssues = catchAsyncError(async (req, res) => {
  const issues = await Issue.find().sort({ createdAt: -1 });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    data: issues,
  });
});
exports.updateIssue = catchAsyncError(async (req, res) => {
  const { issueId } = req.query;
  const { issueName } = req.body;

  if (!issueId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Issue ID is required",
    });
  }

  if (!issueName) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Issue name is required",
    });
  }

  const issue = await Issue.findById(issueId);

  if (!issue) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Issue not found",
    });
  }

  issue.issueName = issueName;
  await issue.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Issue updated successfully",
    data: issue,
  });
});
exports.deleteIssue = catchAsyncError(async (req, res) => {
  const { issueId } = req.query;

  if (!issueId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Issue ID is required",
    });
  }

  const issue = await Issue.findByIdAndDelete(issueId);

  if (!issue) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Issue not found",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Issue deleted successfully",
    data: issue,
  });
});


