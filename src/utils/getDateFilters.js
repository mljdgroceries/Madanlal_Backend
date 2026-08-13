// Utility function to calculate date filters
function getDateFilters(sortBy, fromDate, toDate) {
    const dateFilters = {};
    const now = new Date();
    if (!fromDate && !toDate) {
        if (sortBy === "today" || sortBy === "thisWeek" || sortBy === "thisMonth" || sortBy === "thisYear") {
            let startDate = new Date(0);

            switch (sortBy) {
                case "today":
                    startDate = new Date(now.setHours(0, 0, 0, 0));
                    break;
                case "thisWeek":
                    const firstDayOfWeek = now.getDate() - now.getDay();
                    startDate = new Date(now.setDate(firstDayOfWeek));
                    startDate.setHours(0, 0, 0, 0);
                    break;
                case "thisMonth":
                    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    break;
                case "thisYear":
                    startDate = new Date(now.getFullYear(), 0, 1);
                    break;
            }
            dateFilters.$gte = startDate;
        }
    }

    if (fromDate) {
        dateFilters.$gte = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
    }
    if (toDate) {
        dateFilters.$lte = new Date(new Date(toDate).setHours(23, 59, 59, 999));
    }

    return Object.keys(dateFilters).length > 0 ? dateFilters : null;
}
module.exports = getDateFilters;