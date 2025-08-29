const Order = require("../models/orderModel");

const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user_id", "name email city")
      .populate("event_id", "name type")
      .select("status createdBy grand_total user_id event_id")
      .limit(1);

    const flattened = orders.map((order) => ({
      name: order.user_id?.name || null,
      email: order.user_id?.email || null,
      city: order.user_id?.city || null,
      event_name: order.event_id?.name || null,
      event_type: order.event_id?.type || null,
      grand_total: order.grand_total,
      status: order.status,
      createdBy: order.createdBy,
    }));

    res.status(200).json(flattened);
  } catch (error) {
    console.log("Error in fetching orders:", error.message);
    res.status(500).json({
      message: error.message,
    });
  }
};

const downloadOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user_id", "name email city")
      .populate("event_id", "name type")
      .select("status createdBy grand_total user_id event_id")
      .lean();

    if (orders.length === 0) {
      return res.status(404).json({ message: "No orders found" });
    }

    const headers = [
      "Customer Name",
      "Email",
      "City",
      "Event Name",
      "Event Type",
      "Grand Total",
      "Status",
      "Created At",
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');

    const { Transform } = require("stream");
    const csvTransform = new Transform({
      transform(chunk, encoding, callback) {
        this.push(chunk);
        callback();
      },
    });

    csvTransform.push(`${headers.join(",")}\n`);

    orders.forEach((order) => {
      const row = [
        `"${order.user_id?.name || ""}"`,
        `"${order.user_id?.email || ""}"`,
        `"${order.user_id?.city || ""}"`,
        `"${order.event_id?.name || ""}"`,
        `"${order.event_id?.type || ""}"`,
        order.grand_total || 0,
        `"${order.status || ""}"`,
        `"${
          order.createdBy
            ? new Date(order.createdBy).toLocaleString("en-IN")
            : ""
        }"`,
      ].join(",");

      csvTransform.push(`${row}\n`);
    });

    csvTransform.push(null);

    csvTransform.pipe(res);
  } catch (err) {
    console.error("CSV download error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Error generating CSV file" });
    }
  }
};

const customerCount = async (req, res) => {
  try {
    const count = await Order.countDocuments();
    res.status(200).json({
      success: true,
      totalCustomers: count,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const paidCustomerCount = async (req, res) => {
  try {
    const count = await Order.countDocuments({ status: "completed" });
    res.status(200).json({
      success: true,
      totalCompletedOrders: count,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const pendingCustomerCount = async (req, res) => {
  try {
    const count = await Order.countDocuments({ status: "in_progress" });
    res.status(200).json({
      success: true,
      totalPendingOrders: count,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const avgSpend = async (req, res) => {
  try {
    const result = await Order.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: null,
          averageSpend: { $avg: "$grand_total" },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    const avgSpendValue = result.length ? result[0].averageSpend : 0;
    const totalOrders = result.length ? result[0].totalOrders : 0;

    res.status(200).json({
      success: true,
      averageSpend: avgSpendValue.toFixed(2),
      totalCompletedOrders: totalOrders,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getAllOrders,
  customerCount,
  paidCustomerCount,
  pendingCustomerCount,
  avgSpend,
  downloadOrders,
};
