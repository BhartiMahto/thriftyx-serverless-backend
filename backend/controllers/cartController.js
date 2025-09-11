const Cart = require("../models/cartModel");
const User = require("../models/userModel");
const Event = require("../models/eventModel");

const addToCart = async (req, res) => {
  const { email, phone, name } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  try {
    const filter = phone ? { phone } : { email: lowerCaseEmail };
    const data = await User.findOne(filter);

    if (!data)
      return res
        .status(404)
        .json({ message: "User Not Found", statusCode: 404 });

    if (data && data?.isVerified) {
      const userByPhone = await User.findOne({ phone: req.body.phone });
      if (userByPhone && userByPhone.email !== data.email) {
        return res
          .status(401)
          .json({ message: "Phone Number Already Taken", statusCode: 401 });
      }

      let cartDetails = {
        event_id: req.body.event_id,
        tickets: req.body.tickets,
        total_price: req.body.total_price,
        booking_fee: req.body.booking_fee,
        grand_total: req.body.grand_total,
        gst: req.body.gst,
        user_id: data._id,
        createdBy: new Date(),
        isTnC_accepted: req.body.isTnC_accepted,
      };

      if (lowerCaseEmail || phone) {
        const conditions = [{ _id: { $ne: data._id } }];
        const orConditions = [];

        lowerCaseEmail && orConditions.push({ email: lowerCaseEmail });
        phone && orConditions.push({ phone });

        orConditions.length > 0 && conditions.push({ $or: orConditions });

        const query = { $and: conditions };

        const existingUser = await User.findOne(query);
        if (existingUser) {
          return res.status(409).json({
            message: "Email or Phone Already Exists",
            statusCode: 409,
          });
        }
      }

      let userUpdateBody = {};
      if (data.name !== name) userUpdateBody.name = name;
      if (data.phone !== phone) userUpdateBody.phone = phone;
      if (data.email !== lowerCaseEmail) userUpdateBody.email = lowerCaseEmail;
      if (data.city !== req.body.city) userUpdateBody.city = req.body.city;

      if (Object.keys(userUpdateBody).length > 0) {
        await User.updateOne({ _id: data._id }, { $set: userUpdateBody });
      }

      const eventDetail = await Event.findById(cartDetails.event_id);
      if (!eventDetail) {
        return res
          .status(404)
          .json({ message: "Event Not Found", data: {}, statusCode: 404 });
      }

      const filteredTickets = cartDetails.tickets.filter((cartItem) =>
        eventDetail.tickets.some(
          (eventItem) =>
            cartItem.name === eventItem.name &&
            cartItem.count > eventItem.quantity
        )
      );

      if (filteredTickets && filteredTickets.length > 0) {
        return res.status(406).json({
          message: "Tickets Not Available",
          data: {},
          statusCode: 406,
        });
      }

      const newCartItem = new Cart(cartDetails);
      const cart = await newCartItem.save();

      return res.status(200).json({
        message: "Item Added",
        data: { cart_item_id: cart?._id },
        statusCode: 200,
      });
    } else {
      return res
        .status(201)
        .json({ message: "User Not Verified", statusCode: 201 });
    }
  } catch (err) {
    console.error("AddToCart Error:", err);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const getCartItems = async (req, res) => {
  try {
    let { user_id } = req.query;
    let data = await Cart.find({ user_id });
    return res
      .status(200)
      .json({ statusCode: 200, message: "Cart Items", data: data });
  } catch (error) {
    throw new Error(error);
  }
};

module.exports = { addToCart, getCartItems };
