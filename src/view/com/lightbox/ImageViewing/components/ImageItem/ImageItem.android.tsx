import React, {useState} from 'react'
import {ActivityIndicator, StyleProp, StyleSheet} from 'react-native'
import {
  Gesture,
  GestureDetector,
  PanGesture,
} from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'
import {Image, ImageStyle} from 'expo-image'

import type {Dimensions as ImageDimensions, ImageSource} from '../../@types'
import {
  applyRounding,
  createTransform,
  prependPan,
  prependPinch,
  prependTransform,
  readTransform,
  TransformMatrix,
} from '../../transforms'

const AnimatedImage = Animated.createAnimatedComponent(Image)

const MIN_SCREEN_ZOOM = 2
const MAX_ORIGINAL_IMAGE_ZOOM = 2

const initialTransform = createTransform()

type Props = {
  imageSrc: ImageSource
  onRequestClose: () => void
  onTap: () => void
  onZoom: (isZoomed: boolean) => void
  isScrollViewBeingDragged: boolean
  showControls: boolean
  measureSafeArea: () => {
    x: number
    y: number
    width: number
    height: number
  }
  imageAspect: number | undefined
  imageDimensions: ImageDimensions | undefined
  imageStyle: StyleProp<ImageStyle>
  dismissSwipePan: PanGesture
}
const ImageItem = ({
  imageSrc,
  onTap,
  onZoom,
  isScrollViewBeingDragged,
  measureSafeArea,
  imageAspect,
  imageDimensions,
  imageStyle,
  dismissSwipePan,
}: Props) => {
  const [isScaled, setIsScaled] = useState(false)
  const committedTransform = useSharedValue(initialTransform)
  const panTranslation = useSharedValue({x: 0, y: 0})
  const pinchOrigin = useSharedValue({x: 0, y: 0})
  const pinchScale = useSharedValue(1)
  const pinchTranslation = useSharedValue({x: 0, y: 0})
  const containerRef = useAnimatedRef()

  // Keep track of when we're entering or leaving scaled rendering.
  // Note: DO NOT move any logic reading animated values outside this function.
  useAnimatedReaction(
    () => {
      if (pinchScale.value !== 1) {
        // We're currently pinching.
        return true
      }
      const [, , committedScale] = readTransform(committedTransform.value)
      if (committedScale !== 1) {
        // We started from a pinched in state.
        return true
      }
      // We're at rest.
      return false
    },
    (nextIsScaled, prevIsScaled) => {
      if (nextIsScaled !== prevIsScaled) {
        runOnJS(handleZoom)(nextIsScaled)
      }
    },
  )

  function handleZoom(nextIsScaled: boolean) {
    setIsScaled(nextIsScaled)
    onZoom(nextIsScaled)
  }

  const animatedStyle = useAnimatedStyle(() => {
    // Apply the active adjustments on top of the committed transform before the gestures.
    // This is matrix multiplication, so operations are applied in the reverse order.
    let t = createTransform()
    prependPan(t, panTranslation.value)
    prependPinch(t, pinchScale.value, pinchOrigin.value, pinchTranslation.value)
    prependTransform(t, committedTransform.value)
    const [translateX, translateY, scale] = readTransform(t)
    return {
      transform: [{translateX}, {translateY: translateY}, {scale}],
    }
  })

  // On Android, stock apps prevent going "out of bounds" on pan or pinch. You should "bump" into edges.
  // If the user tried to pan too hard, this function will provide the negative panning to stay in bounds.
  function getExtraTranslationToStayInBounds(
    candidateTransform: TransformMatrix,
    screenSize: {width: number; height: number},
  ) {
    'worklet'
    if (!imageAspect) {
      return [0, 0]
    }
    const [nextTranslateX, nextTranslateY, nextScale] =
      readTransform(candidateTransform)
    const scaledDimensions = getScaledDimensions(
      imageAspect,
      nextScale,
      screenSize,
    )
    const clampedTranslateX = clampTranslation(
      nextTranslateX,
      scaledDimensions.width,
      screenSize.width,
    )
    const clampedTranslateY = clampTranslation(
      nextTranslateY,
      scaledDimensions.height,
      screenSize.height,
    )
    const dx = clampedTranslateX - nextTranslateX
    const dy = clampedTranslateY - nextTranslateY
    return [dx, dy]
  }

  const pinch = Gesture.Pinch()
    .onStart(e => {
      'worklet'
      const screenSize = measureSafeArea()
      pinchOrigin.value = {
        x: e.focalX - screenSize.width / 2,
        y: e.focalY - screenSize.height / 2,
      }
    })
    .onChange(e => {
      'worklet'
      const screenSize = measureSafeArea()
      if (!imageDimensions) {
        return
      }
      // Don't let the picture zoom in so close that it gets blurry.
      // Also, like in stock Android apps, don't let the user zoom out further than 1:1.
      const [, , committedScale] = readTransform(committedTransform.value)
      const maxCommittedScale = Math.max(
        MIN_SCREEN_ZOOM,
        (imageDimensions.width / screenSize.width) * MAX_ORIGINAL_IMAGE_ZOOM,
      )
      const minPinchScale = 1 / committedScale
      const maxPinchScale = maxCommittedScale / committedScale
      const nextPinchScale = Math.min(
        Math.max(minPinchScale, e.scale),
        maxPinchScale,
      )
      pinchScale.value = nextPinchScale

      // Zooming out close to the corner could push us out of bounds, which we don't want on Android.
      // Calculate where we'll end up so we know how much to translate back to stay in bounds.
      const t = createTransform()
      prependPan(t, panTranslation.value)
      prependPinch(t, nextPinchScale, pinchOrigin.value, pinchTranslation.value)
      prependTransform(t, committedTransform.value)
      const [dx, dy] = getExtraTranslationToStayInBounds(t, screenSize)
      if (dx !== 0 || dy !== 0) {
        pinchTranslation.value = {
          x: pinchTranslation.value.x + dx,
          y: pinchTranslation.value.y + dy,
        }
      }
    })
    .onEnd(() => {
      'worklet'
      // Commit just the pinch.
      let t = createTransform()
      prependPinch(
        t,
        pinchScale.value,
        pinchOrigin.value,
        pinchTranslation.value,
      )
      prependTransform(t, committedTransform.value)
      applyRounding(t)
      committedTransform.value = t

      // Reset just the pinch.
      pinchScale.value = 1
      pinchOrigin.value = {x: 0, y: 0}
      pinchTranslation.value = {x: 0, y: 0}
    })

  const pan = Gesture.Pan()
    .averageTouches(true)
    // Unlike .enabled(isScaled), this ensures that an initial pinch can turn into a pan midway:
    .minPointers(isScaled ? 1 : 2)
    .onChange(e => {
      'worklet'
      const screenSize = measureSafeArea()
      if (!imageDimensions) {
        return
      }

      const nextPanTranslation = {x: e.translationX, y: e.translationY}
      let t = createTransform()
      prependPan(t, nextPanTranslation)
      prependPinch(
        t,
        pinchScale.value,
        pinchOrigin.value,
        pinchTranslation.value,
      )
      prependTransform(t, committedTransform.value)

      // Prevent panning from going out of bounds.
      const [dx, dy] = getExtraTranslationToStayInBounds(t, screenSize)
      nextPanTranslation.x += dx
      nextPanTranslation.y += dy
      panTranslation.value = nextPanTranslation
    })
    .onEnd(() => {
      'worklet'
      // Commit just the pan.
      let t = createTransform()
      prependPan(t, panTranslation.value)
      prependTransform(t, committedTransform.value)
      applyRounding(t)
      committedTransform.value = t

      // Reset just the pan.
      panTranslation.value = {x: 0, y: 0}
    })

  const singleTap = Gesture.Tap().onEnd(() => {
    'worklet'
    runOnJS(onTap)()
  })

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(e => {
      'worklet'
      const screenSize = measureSafeArea()
      if (!imageDimensions || !imageAspect) {
        return
      }
      const [, , committedScale] = readTransform(committedTransform.value)
      if (committedScale !== 1) {
        // Go back to 1:1 using the identity vector.
        let t = createTransform()
        committedTransform.value = withClampedSpring(t)
        return
      }

      // Try to zoom in so that we get rid of the black bars (whatever the orientation was).
      const screenAspect = screenSize.width / screenSize.height
      const candidateScale = Math.max(
        imageAspect / screenAspect,
        screenAspect / imageAspect,
        MIN_SCREEN_ZOOM,
      )
      // But don't zoom in so close that the picture gets blurry.
      const maxScale = Math.max(
        MIN_SCREEN_ZOOM,
        (imageDimensions.width / screenSize.width) * MAX_ORIGINAL_IMAGE_ZOOM,
      )
      const scale = Math.min(candidateScale, maxScale)

      // Calculate where we would be if the user pinched into the double tapped point.
      // We won't use this transform directly because it may go out of bounds.
      const candidateTransform = createTransform()
      const origin = {
        x: e.absoluteX - screenSize.width / 2,
        y: e.absoluteY - screenSize.height / 2,
      }
      prependPinch(candidateTransform, scale, origin, {x: 0, y: 0})

      // Now we know how much we went out of bounds, so we can shoot correctly.
      const [dx, dy] = getExtraTranslationToStayInBounds(
        candidateTransform,
        screenSize,
      )
      const finalTransform = createTransform()
      prependPinch(finalTransform, scale, origin, {x: dx, y: dy})
      committedTransform.value = withClampedSpring(finalTransform)
    })

  const composedGesture = isScrollViewBeingDragged
    ? // If the parent is not at rest, provide a no-op gesture.
      Gesture.Manual()
    : Gesture.Exclusive(
        dismissSwipePan,
        Gesture.Simultaneous(pinch, pan),
        doubleTap,
        singleTap,
      )

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View renderToHardwareTextureAndroid>
        <Animated.View
          ref={containerRef}
          // Necessary to make opacity work for both children together.
          renderToHardwareTextureAndroid
          style={[styles.container, animatedStyle]}>
          <ActivityIndicator size="small" color="#FFF" style={styles.loading} />
          <AnimatedImage
            contentFit="cover"
            source={{uri: imageSrc.uri}}
            placeholderContentFit="cover"
            placeholder={{uri: imageSrc.thumbUri}}
            style={imageStyle}
            accessibilityLabel={imageSrc.alt}
            accessibilityHint=""
            accessibilityIgnoresInvertColors
            cachePolicy="memory"
          />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  container: {
    height: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  loading: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
})

function getScaledDimensions(
  imageAspect: number,
  scale: number,
  screenSize: {width: number; height: number},
): ImageDimensions {
  'worklet'
  const screenAspect = screenSize.width / screenSize.height
  const isLandscape = imageAspect > screenAspect
  if (isLandscape) {
    return {
      width: scale * screenSize.width,
      height: (scale * screenSize.width) / imageAspect,
    }
  } else {
    return {
      width: scale * screenSize.height * imageAspect,
      height: scale * screenSize.height,
    }
  }
}

function clampTranslation(
  value: number,
  scaledSize: number,
  screenSize: number,
): number {
  'worklet'
  // Figure out how much the user should be allowed to pan, and constrain the translation.
  const panDistance = Math.max(0, (scaledSize - screenSize) / 2)
  const clampedValue = Math.min(Math.max(-panDistance, value), panDistance)
  return clampedValue
}

function withClampedSpring(value: any) {
  'worklet'
  return withSpring(value, {overshootClamping: true})
}

export default React.memo(ImageItem)
