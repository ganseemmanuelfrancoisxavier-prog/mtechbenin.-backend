const express = require("express");
const router  = express.Router();
const { login, refreshToken, logout, getMe } = require("./auth.controller");
const { isAdmin }       = require("../../middleware/auth");
const { strictLimiter } = require("../../middleware/rateLimiter");

router.post("/login",   strictLimiter, login);
router.post("/refresh", refreshToken);
router.post("/logout",  isAdmin, logout);
router.get("/me",       isAdmin, getMe);

module.exports = router;
