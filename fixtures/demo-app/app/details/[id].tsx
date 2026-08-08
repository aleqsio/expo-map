import BottomSheet from '@gorhom/bottom-sheet';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef } from 'react';
import { Button, Text, View } from 'react-native';

export default function Details() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['25%', '50%', '90%'], []);

  return (
    <View>
      <Text>Details for {id}</Text>
      <Button title="Open sheet" onPress={() => sheetRef.current?.expand()} />
      <Button title="Back home" onPress={() => router.replace('/')} />
      <Link href={`/details/${Number(id) + 1}`}>Next item</Link>
      <BottomSheet ref={sheetRef} snapPoints={snapPoints} index={-1}>
        <Text>Sheet content</Text>
      </BottomSheet>
    </View>
  );
}
