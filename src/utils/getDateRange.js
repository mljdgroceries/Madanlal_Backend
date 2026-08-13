exports.getDateRange = (timeframe) => {
    const now = new Date();
    let startDate, endDate;

    switch (timeframe) {
        case 'today':
            startDate = new Date(now.setHours(0, 0, 0, 0));
            endDate = new Date(now.setHours(23, 59, 59, 999));
            break;
        case 'week':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - now.getDay() + 1); // Monday
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date();
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'month':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date();
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'year':
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date();
            endDate.setHours(23, 59, 59, 999);
            break;
        default:
            return null; // Invalid timeframe
    }

    return { $gte: startDate, $lte: endDate };
};