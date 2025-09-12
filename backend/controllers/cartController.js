const Cart = require("../models/cartModel");
const User = require("../models/userModel");
const Event = require("../models/eventModel");

const addToCart = async (req, res) => {
  const { email, phone, name } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  try {
    let user = null;

    if (lowerCaseEmail || phone) {
      const filter = phone ? { phone } : { email: lowerCaseEmail };
      user = await User.findOne(filter);

      // if (user && user.isVerified) {
      //   let userUpdateBody = {};
      //   if (user.name !== name) userUpdateBody.name = name;
      //   if (user.phone !== phone) userUpdateBody.phone = phone;
      //   if (user.email !== lowerCaseEmail)
      //     userUpdateBody.email = lowerCaseEmail;
      //   if (user.city !== req.body.city) userUpdateBody.city = req.body.city;

      //   if (Object.keys(userUpdateBody).length > 0) {
      //     await User.updateOne({ _id: user._id }, { $set: userUpdateBody });
      //   }
      // }
    }

    let cartDetails = {
      event_id: req.body.event_id,
      tickets: req.body.tickets,
      total_price: req.body.total_price,
      booking_fee: req.body.booking_fee,
      grand_total: req.body.grand_total,
      gst: req.body.gst,
      user_id: user ? user._id : null,
      createdBy: new Date(),
      isTnC_accepted: req.body.isTnC_accepted,
    };

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
    let cart = await newCartItem.save();
    cart = await cart.populate('event_id');

    return res.status(200).json({
      message: "Item Added",
      data: { cart_item_id: cart?._id },
      statusCode: 200,
    });
  } catch (err) {
    console.error("AddToCart Error:", err);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const getCartItems = async (req, res) => {
  try {
    let { user_id } = req.query;
    let data = await Cart.find({ user_id }).populate('event_id');
    return res
      .status(200)
      .json({ statusCode: 200, message: "Cart Items", data: data });
  } catch (error) {
    throw new Error(error);
  }
};

const deleteCartItem = async (req, res) => {
    try {
        const deletedItem = await Cart.findByIdAndDelete(req.params.id);
        if (!deletedItem) {
            return res.status(404).json({ message: "Cart item not found" });
        }
        res.status(200).json({ message: "Item removed successfully" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const updateCartItem = async (req, res) => {
    const { tickets, total_price, grand_total } = req.body;
    try {
        const updatedItem = await Cart.findByIdAndUpdate(req.params.id, 
            { tickets, total_price, grand_total }, 
            { new: true }
        );
        if (!updatedItem) {
            return res.status(404).json({ message: "Cart item not found" });
        }
        res.status(200).json({ message: "Cart updated", data: updatedItem });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};


module.exports = { addToCart, getCartItems, deleteCartItem, updateCartItem };