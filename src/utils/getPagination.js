// Utility function for pagination
function getPagination(page, limit) {
    const parsedPage = parseInt(page) || 1;
    const parsedLimit = parseInt(limit) > 0 ? parseInt(limit) : 10; // Default to 10 if limit is invalid or 0

    const skip = (parsedPage - 1) * parsedLimit;
    return { skip, limitNum: parsedLimit };
}
module.exports = getPagination;